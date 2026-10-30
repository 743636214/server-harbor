import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { createDatabase } from '../server/db.mjs';
import { hashPassword } from '../server/crypto.mjs';
import { loadEnvironment } from '../server/secrets.mjs';
import { nextBeijingMidnight } from '../server/login-security.mjs';
const accountKey = (id) =>
  createHash('sha256')
    .update('user:' + id)
    .digest('hex');
const password = 'lockout-test-password-only';

test('登录连续五次失败后锁定至次日，状态持久化且并发不可绕过', { timeout: 60000 }, async (t) => {
  const env = await loadEnvironment({
    file: process.env.HARBOR_TEST_ENV_FILE || new URL('../.env.test', import.meta.url),
    env: {},
  });
  assert.equal(env.MYSQL_DATABASE, 'server_harbor_test');
  const db = await createDatabase(env),
    otherDb = await createDatabase(env),
    key = randomBytes(32);
  const revoked = [],
    apps = [];
  const tables = [
    'login_attempts',
    'server_cloud_bindings',
    'cloud_credentials',
    'sessions',
    'user_favorites',
    'recordings',
    'audit_events',
    'connection_actors',
    'connections',
    'servers',
    'users',
    'settings',
  ];
  async function clean() {
    for (const table of tables) await db.query('DELETE FROM ' + table);
  }
  await clean();
  const hash = await hashPassword(password);
  async function user(name, active = true, role = 'member') {
    const id = randomUUID();
    await db.execute(
      'INSERT INTO users(id,username,display_name,password_hash,role,permissions,active) VALUES (?,?,?,?,?,?,?)',
      [id, name, name, hash, role, '{}', active],
    );
    return { id, name };
  }
  async function open(pool = db) {
    const app = createApp({
      db: pool,
      key,
      bridge: { revokeUser: async (id) => revoked.push(id) },
    });
    const server = await new Promise((resolve) => {
      const http = app.listen(0, '127.0.0.1', () => resolve(http));
    });
    const handle = {
      async request(route, body, cookie) {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + route, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Server-Harbor': '1',
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: response.status,
          data: await response.json(),
          cookie: response.headers.get('set-cookie')?.split(';')[0],
          retry: response.headers.get('retry-after'),
        };
      },
      login(name, value = password) {
        return this.request('/auth/login', { username: name, password: value });
      },
      async close() {
        if (this.closed) return;
        this.closed = true;
        app.harborClose();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      },
    };
    apps.push(handle);
    return handle;
  }
  try {
    await t.test('前四次失败提示剩余次数，第五次锁定，正确密码也不能登录', async () => {
      const target = await user('fivelimit'),
        api = await open();
      const original = await api.login(target.name);
      assert.equal(original.status, 200);
      for (let count = 1; count < 5; count++) {
        const response = await api.login(target.name, 'wrong');
        assert.equal(response.status, 401);
        assert.equal(response.data.remaining_attempts, 5 - count);
      }
      const locked = await api.login(target.name, 'wrong');
      assert.equal(locked.status, 429);
      assert.equal(locked.data.code, 'ACCOUNT_LOCKED');
      assert.ok(Number(locked.retry) > 0);
      assert.ok(!locked.cookie);
      const [[clock]] = await db.query('SELECT UTC_TIMESTAMP(3) AS now');
      assert.equal(
        locked.data.locked_until,
        nextBeijingMidnight(new Date(clock.now)).toISOString(),
      );
      const correct = await api.login(target.name);
      assert.equal(correct.status, 429);
      assert.equal(correct.data.locked_until, locked.data.locked_until);
      assert.equal((await api.login(target.name.toUpperCase())).data.code, 'ACCOUNT_LOCKED');
      const [[state]] = await db.execute('SELECT * FROM login_attempts WHERE account_hash=?', [
        accountKey(target.id),
      ]);
      assert.equal(state.failed_count, 5);
      assert.equal((await api.request('/servers', undefined, original.cookie)).status, 401);
      assert.ok(revoked.includes(target.id));
      const [[count]] = await db.execute(
        "SELECT COUNT(*) AS total FROM audit_events WHERE action='account.login.lock'",
      );
      assert.equal(count.total, 1);
    });
    await t.test('重建应用实例仍然锁定，更改账号名称也不能绕过', async () => {
      const [[target]] = await db.execute("SELECT id FROM users WHERE username='fivelimit'");
      await db.execute("UPDATE users SET username='renamedlock' WHERE id=?", [target.id]);
      const api = await open(otherDb);
      assert.equal((await api.login('renamedlock')).data.code, 'ACCOUNT_LOCKED');
    });
    await t.test('多个实例的并发失败只累加五次并锁定，其他账号不受影响', async () => {
      const target = await user('parallelcase'),
        other = await user('notlocked'),
        first = await open(),
        second = await open(otherDb);
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          (i % 2 ? first : second).login(i % 2 ? target.name : target.name.toUpperCase(), 'wrong'),
        ),
      );
      assert.equal(results.filter((result) => result.status === 401).length, 4);
      assert.equal(results.filter((result) => result.data.code === 'ACCOUNT_LOCKED').length, 12);
      const [[state]] = await db.execute(
        'SELECT failed_count FROM login_attempts WHERE account_hash=?',
        [accountKey(target.id)],
      );
      assert.equal(state.failed_count, 5);
      assert.equal((await first.login(other.name)).status, 200);
    });
    await t.test('锁定前登录成功清零失败次数', async () => {
      const target = await user('resetcount'),
        api = await open();
      for (let i = 0; i < 4; i++) assert.equal((await api.login(target.name, 'wrong')).status, 401);
      assert.equal((await api.login(target.name)).status, 200);
      const next = await api.login(target.name, 'wrong');
      assert.equal(next.status, 401);
      assert.equal(next.data.remaining_attempts, 4);
    });
    await t.test('次日到期自动解锁并清零，手动停用账号保持停用', async () => {
      const target = await user('nextday'),
        inactive = await user('disabledcase', false),
        api = await open();
      for (const entry of [target, inactive]) {
        await db.execute(
          'INSERT INTO login_attempts(account_hash,failed_count,attempt_day,locked_until) VALUES (?,5,DATE_SUB(DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR),INTERVAL 1 DAY),DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND))',
          [accountKey(entry.id)],
        );
      }
      assert.equal((await api.login(target.name)).status, 200);
      const [[state]] = await db.execute(
        'SELECT failed_count,locked_until FROM login_attempts WHERE account_hash=?',
        [accountKey(target.id)],
      );
      assert.equal(state.failed_count, 0);
      assert.equal(state.locked_until, null);
      assert.equal((await api.login(inactive.name)).status, 401);
      const [[stillDisabled]] = await db.execute('SELECT active FROM users WHERE id=?', [
        inactive.id,
      ]);
      assert.equal(stillDisabled.active, 0);
      const [[unlocks]] = await db.query(
        "SELECT COUNT(*) AS total FROM audit_events WHERE action='account.login.unlock'",
      );
      assert.equal(unlocks.total, 2);
    });
    await t.test('仅管理员可手动解锁，立即清零并审计；旧会话不会被恢复', async () => {
      const admin = await user('unlockadmin', true, 'admin'),
        target = await user('unlocktarget'),
        member = await user('unlockobserver'),
        api = await open();
      const adminLogin = await api.login(admin.name),
        original = await api.login(target.name),
        memberLogin = await api.login(member.name);
      for (let i = 0; i < 5; i++) await api.login(target.name, 'wrong');
      const route = '/users/' + target.id.toUpperCase() + '/unlock';
      assert.equal((await api.request(route, {})).status, 401);
      assert.equal((await api.request(route, {}, original.cookie)).status, 401);
      assert.equal((await api.request(route, {}, memberLogin.cookie)).status, 403);
      const stillLocked = await api.login(target.name);
      assert.equal(stillLocked.data.code, 'ACCOUNT_LOCKED');
      const before = await api.request('/users', undefined, adminLogin.cookie);
      assert.ok(before.data.find((u) => u.id === target.id).login_locked_until);
      const unlocked = await api.request(route, {}, adminLogin.cookie);
      assert.equal(unlocked.status, 200);
      assert.ok(!unlocked.cookie);
      const [[state]] = await db.execute(
        'SELECT failed_count,locked_until FROM login_attempts WHERE account_hash=?',
        [accountKey(target.id)],
      );
      assert.equal(state.failed_count, 0);
      assert.equal(state.locked_until, null);
      assert.equal((await api.request('/servers', undefined, original.cookie)).status, 401);
      assert.equal((await api.login(target.name)).status, 200);
      assert.equal((await api.login(target.name, 'wrong')).data.remaining_attempts, 4);
      const after = await api.request('/users', undefined, adminLogin.cookie);
      assert.equal(after.data.find((u) => u.id === target.id).login_locked_until, null);
      const [[entry]] = await db.execute(
        "SELECT * FROM audit_events WHERE action='account.login.admin_unlock' AND actor_id=?",
        [admin.id],
      );
      const details = typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details;
      assert.equal(entry.actor_username, admin.name);
      assert.equal(details.targetUserId, target.id);
      assert.equal(details.account, target.name);
      assert.equal(details.previousFailures, 5);
      assert.equal(details.manuallyDisabled, false);
      assert.equal(
        (await api.request('/users/' + randomUUID() + '/unlock', {}, adminLogin.cookie)).status,
        404,
      );
    });
    await t.test('管理员可以解锁其他管理员；解除登录锁定不会启用手动停用账号', async () => {
      const admin = await user('secondunlockadmin', true, 'admin'),
        target = await user('lockedadmin', true, 'admin'),
        inactive = await user('manualdisabled', false),
        api = await open();
      const operator = await api.login(admin.name);
      for (const account of [target, inactive]) {
        await db.execute(
          'INSERT INTO login_attempts(account_hash,failed_count,attempt_day,locked_until) VALUES (?,5,DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR),TIMESTAMP(DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR)+INTERVAL 1 DAY)-INTERVAL 8 HOUR)',
          [accountKey(account.id)],
        );
        const unlocked = await api.request('/users/' + account.id + '/unlock', {}, operator.cookie);
        assert.equal(unlocked.status, 200);
      }
      assert.equal((await api.login(target.name)).status, 200);
      assert.equal((await api.login(inactive.name)).status, 401);
      const [[state]] = await db.execute('SELECT active FROM users WHERE id=?', [inactive.id]);
      assert.equal(state.active, 0);
    });
    await t.test('未知账号采取相同锁定响应且不保存原始账号或密码', async () => {
      const api = await open(),
        name = 'unknown-lock-case';
      for (let i = 0; i < 4; i++) assert.equal((await api.login(name, 'wrong')).status, 401);
      const response = await api.login(name, 'wrong');
      assert.equal(response.data.code, 'ACCOUNT_LOCKED');
      const [rows] = await db.query('SELECT * FROM login_attempts');
      assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.account_hash)));
      assert.ok(!JSON.stringify(rows).includes(password));
    });
  } finally {
    await Promise.all(apps.map((app) => app.close()));
    await clean();
    await otherDb.end();
    await db.end();
  }
});
