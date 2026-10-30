import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnvironment } from '../server/secrets.mjs';
import { request as httpRequest } from 'node:http';
import { createDatabase } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { createBridge } from '../server/ssh.mjs';
import { createRecording } from '../server/recordings.mjs';
import { decrypt } from '../server/crypto.mjs';
import { permissionsFor, transaction } from '../server/permissions.mjs';
import { writeAudit } from '../server/audit.mjs';
import { mockSSH, throughBridge } from './ssh.test.mjs';
let env;
try {
  env = await loadEnvironment({
    file: process.env.HARBOR_TEST_ENV_FILE || new URL('../.env.test', import.meta.url),
    env: {},
  });
} catch {}
const emptyPermissions = {
  'server.create': false,
  'server.edit': false,
  'server.delete': false,
  'server.connect': true,
};
const waitFor = async (check) => {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Async state did not settle');
};
async function clean(db) {
  for (const table of [
    'login_attempts',
    'sessions',
    'user_favorites',
    'recordings',
    'audit_events',
    'connection_actors',
    'connections',
    'servers',
    'users',
    'settings',
  ])
    await db.query('DELETE FROM ' + table);
}
test(
  '多人共享库、细粒度权限、审计、网关、录制回放和安全边界',
  { skip: !env, timeout: 60000 },
  async (t) => {
    assert.equal(env.MYSQL_DATABASE, 'server_harbor_test');
    const db = await createDatabase(env),
      mock = await mockSSH(),
      dir = await mkdtemp(path.join(tmpdir(), 'harbor-v2-')),
      recordingDir = path.join(dir, 'recordings'),
      key = Buffer.from(env.VAULT_KEY, 'hex');
    await clean(db);
    const bridge = await createBridge({
      port: 0,
      dataDir: dir,
      vaultKey: key,
      authorize: async (meta) => {
        const [[user]] = await db.execute('SELECT * FROM users WHERE id=?', [meta.user.id]);
        return Boolean(user?.active && permissionsFor(user)['server.connect']);
      },
      record: (ticket, onFailure) =>
        createRecording({
          db,
          key,
          dir: recordingDir,
          id: ticket.id,
          user: ticket.meta.user,
          server: ticket.server,
          onFailure,
        }),
      onStatus: async (id, serverId, status, message, meta) =>
        transaction(db, async (store) => {
          const [[row]] = await store.execute('SELECT * FROM connections WHERE id=? FOR UPDATE', [
            id,
          ]);
          if (!row || ['failed', 'closed'].includes(row.status)) return;
          await store.execute('UPDATE connections SET status=?,message=? WHERE id=?', [
            status,
            message,
            id,
          ]);
          await writeAudit(store, {
            user: meta.user,
            server: { id: serverId, name: row.server_name },
            action: 'ssh.' + status,
            outcome: status === 'failed' ? 'failed' : 'success',
            details: { connectionId: id },
          });
        }),
    });
    const app = createApp({ db, key, bridge, recordingDir }),
      http = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      }),
      base = 'http://127.0.0.1:' + http.address().port;
    const client = () => {
      let cookie = '';
      return {
        async req(url, method = 'GET', body, headers = {}) {
          const r = await fetch(base + '/api' + url, {
            method,
            headers: {
              'Content-Type': 'application/json',
              'X-Server-Harbor': '1',
              ...(cookie ? { Cookie: cookie } : {}),
              ...headers,
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
          const c = r.headers.get('set-cookie');
          if (c) cookie = c.split(';')[0];
          return { status: r.status, data: await r.json(), headers: r.headers };
        },
        cookie: () => cookie,
      };
    };
    const admin = client(),
      member = client(),
      other = client();
    let serverId, memberId, connectionId;
    const body = {
      name: '共享服务器 #杭州',
      host: mock.host,
      port: mock.port,
      username: mock.username,
      auth_type: 'password',
      password: 'ssh-test-password',
      environment: 'production',
      tags: ['shared'],
      notes: 'test',
    };
    try {
      await t.test('首次管理员与登录防护', async () => {
        assert.equal((await admin.req('/servers')).status, 401);
        assert.equal(
          (
            await admin.req(
              '/auth/setup',
              'POST',
              { username: 'admin', password: 'management-password' },
              { Origin: 'https://evil.example' },
            )
          ).status,
          403,
        );
        const setup = await admin.req('/auth/setup', 'POST', {
          username: 'admin',
          password: 'management-password',
        });
        assert.equal(setup.status, 200);
        assert.equal(setup.data.user.role, 'admin');
        assert.ok(!admin.cookie().includes('management-password'));
        assert.equal(
          (await admin.req('/auth/setup', 'POST', { password: 'another-password' })).status,
          409,
        );
        const bad = await new Promise((resolve) => {
          const r = httpRequest(
            base + '/api/servers',
            { headers: { Host: 'evil.example' } },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            },
          );
          r.end();
        });
        assert.equal(bad, 403);
        assert.equal(
          (await admin.req('/servers', 'POST', { ...body, host: '127.0.0.1;id' })).status,
          400,
        );
      });
      await t.test('共同服务器库与加密存储', async () => {
        const result = await admin.req('/servers', 'POST', { ...body, favorite: true });
        assert.equal(result.status, 201, JSON.stringify(result.data));
        serverId = result.data.id;
        assert.equal('credentials' in result.data, false);
        const [[row]] = await db.execute('SELECT credentials FROM servers WHERE id=?', [serverId]);
        assert.ok(!row.credentials.includes(body.password));
        assert.equal(decrypt(row.credentials, key, serverId).password, body.password);
        for (const name of ['member', 'other']) {
          const r = await admin.req('/users', 'POST', {
            username: name,
            display_name: name,
            role: 'member',
            permissions: emptyPermissions,
            password: 'member-test-password',
          });
          assert.equal(r.status, 201);
          if (name === 'member') memberId = r.data.id;
        }
        assert.equal(
          (
            await member.req('/auth/login', 'POST', {
              username: 'member',
              password: 'member-test-password',
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await other.req('/auth/login', 'POST', {
              username: 'other',
              password: 'member-test-password',
            })
          ).status,
          200,
        );
        const list = (await member.req('/servers')).data;
        assert.equal(list[0].id, serverId);
        assert.equal(list[0].favorite, false);
        await member.req('/servers/' + serverId + '/favorite', 'PATCH', { favorite: true });
        assert.equal((await other.req('/servers')).data[0].favorite, false);
      });
      await t.test('未授权增改删、账号管理、指纹修改均被后端拒绝并记录', async () => {
        assert.equal((await member.req('/servers', 'POST', body)).status, 403);
        assert.equal(
          (await member.req('/servers/' + serverId, 'PUT', { ...body, password: '' })).status,
          403,
        );
        assert.equal((await member.req('/servers/' + serverId, 'DELETE', {})).status, 403);
        assert.equal((await member.req('/users')).status, 403);
        assert.equal(
          (await member.req('/servers/' + serverId + '/fingerprint', 'POST', {})).status,
          403,
        );
        assert.equal(
          (await member.req('/servers/' + serverId + '/trust', 'POST', { ticket: 'x' })).status,
          403,
        );
        assert.equal(
          (await member.req('/servers/' + serverId + '/connect', 'POST', {})).data.code,
          'HOST_KEY_REQUIRED',
        );
        const logs = (await admin.req('/audit?q=member&outcome=denied')).data.rows;
        assert.ok(logs.some((l) => l.action === 'permission.denied' && l.server_id === serverId));
        const own = (await member.req('/audit')).data.rows;
        assert.ok(own.every((l) => l.actor_username === 'member'));
      });
      await t.test('管理员授权后修改立即生效，不能顺带越权删除', async () => {
        const update = await admin.req('/users/' + memberId, 'PUT', {
          username: 'member',
          display_name: 'Member',
          role: 'member',
          active: true,
          permissions: { ...emptyPermissions, 'server.edit': true },
        });
        assert.equal(update.status, 200);
        assert.equal((await member.req('/servers')).status, 401);
        await member.req('/auth/login', 'POST', {
          username: 'member',
          password: 'member-test-password',
        });
        assert.equal(
          (
            await member.req('/servers/' + serverId, 'PUT', {
              ...body,
              password: '',
              name: '授权后修改',
            })
          ).status,
          200,
        );
        assert.equal((await member.req('/servers/' + serverId, 'DELETE', {})).status, 403);
        const fp = await member.req('/servers/' + serverId + '/fingerprint', 'POST', {});
        assert.equal(fp.status, 200);
        assert.equal(mock.authCount(), 0);
        assert.equal(
          (await admin.req('/servers/' + serverId + '/trust', 'POST', { ticket: fp.data.ticket }))
            .status,
          400,
        );
        const ownFp = await member.req('/servers/' + serverId + '/fingerprint', 'POST', {});
        assert.equal(
          (
            await member.req('/servers/' + serverId + '/trust', 'POST', {
              ticket: ownFp.data.ticket,
            })
          ).status,
          200,
        );
      });
      await t.test('成员连接网关，无桌面依赖，输入输出被加密录制', async () => {
        const result = await member.req('/servers/' + serverId + '/connect', 'POST', {});
        assert.equal(result.status, 200, JSON.stringify(result.data));
        connectionId = result.data.id;
        assert.ok(result.data.url.startsWith('termius://'));
        assert.match(await throughBridge(result.data.url), /CONNECTED:test-user/);
        await waitFor(async () => {
          const [[r]] = await db.execute('SELECT * FROM recordings WHERE connection_id=?', [
            connectionId,
          ]);
          return r?.state === 'complete' && r;
        });
        const raw = await readFile(path.join(recordingDir, connectionId + '.jsonl'), 'utf8');
        assert.ok(!raw.includes('CONNECTED'));
        assert.ok(!raw.includes('hello'));
        assert.equal((await member.req('/recordings/' + connectionId)).status, 403);
        const replay = await admin.req('/recordings/' + connectionId);
        assert.equal(replay.status, 200, JSON.stringify(replay.data));
        assert.equal(replay.data.verified, true);
        assert.ok(
          replay.data.events.some(
            (e) => e.type === 'input' && Buffer.from(e.data, 'base64').toString().includes('hello'),
          ),
        );
        assert.ok(
          replay.data.events.some(
            (e) =>
              e.type === 'output' && Buffer.from(e.data, 'base64').toString().includes('CONNECTED'),
          ),
        );
        const logs = (await admin.req('/audit?q=ssh.')).data.rows;
        assert.ok(
          logs.some(
            (l) =>
              l.actor_username === 'member' &&
              l.server_id === serverId &&
              l.action === 'ssh.connected',
          ),
        );
        const memberLogs = (await member.req('/audit')).data.rows;
        assert.ok(memberLogs.every((l) => l.actor_username === 'member'));
        assert.ok(!JSON.stringify((await admin.req('/audit')).data).includes(body.password));
        await assert.rejects(throughBridge(result.data.url));
      });
      await t.test('录制篡改会被拒绝，分页仍要求管理员', async () => {
        const file = path.join(recordingDir, connectionId + '.jsonl'),
          original = await readFile(file, 'utf8');
        const lines = original.trimEnd().split('\n');
        const part = JSON.parse(lines[0]);
        const encrypted = JSON.parse(part.body);
        encrypted.body = 'AAAA' + encrypted.body.slice(4);
        part.body = JSON.stringify(encrypted);
        lines[0] = JSON.stringify(part);
        await writeFile(file, lines.join('\n') + '\n');
        assert.equal((await admin.req('/recordings/' + connectionId)).status, 409);
        await writeFile(file, original);
        assert.equal(
          (await admin.req('/recordings/' + connectionId + '?limit=1')).data.events.length,
          1,
        );
        assert.equal((await other.req('/recordings/' + connectionId + '?from=1')).status, 403);
      });
      await t.test('私钥模式仍可连接，撤销账号连接权限使未使用票据失效', async () => {
        assert.equal(
          (
            await admin.req('/servers/' + serverId, 'PUT', {
              ...body,
              auth_type: 'key',
              privateKey: mock.privateKey,
            })
          ).status,
          200,
        );
        const pending = await member.req('/servers/' + serverId + '/connect', 'POST', {});
        assert.equal(pending.status, 200);
        await admin.req('/users/' + memberId, 'PUT', {
          username: 'member',
          display_name: 'Member',
          role: 'member',
          active: true,
          permissions: { ...emptyPermissions, 'server.connect': false },
        });
        await assert.rejects(throughBridge(pending.data.url));
        await member.req('/auth/login', 'POST', {
          username: 'member',
          password: 'member-test-password',
        });
        assert.equal(
          (await member.req('/servers/' + serverId + '/connect', 'POST', {})).status,
          403,
        );
        const ok = await admin.req('/servers/' + serverId + '/connect', 'POST', {});
        assert.equal(ok.status, 200);
        assert.match(await throughBridge(ok.data.url), /ECHO:hello/);
      });
      await t.test('删除服务器后仍保留账号、目标名称和录制，停用账号立即退出', async () => {
        assert.equal((await admin.req('/servers/' + serverId, 'DELETE', {})).status, 200);
        const logs = (await admin.req('/audit?server_id=' + serverId)).data.rows;
        assert.ok(
          logs.some(
            (l) => l.action === 'server.delete' && l.actor_username === 'admin' && l.server_name,
          ),
        );
        assert.equal((await admin.req('/recordings/' + connectionId)).status, 200);
        const history = (await admin.req('/connections')).data;
        assert.ok(history.every((c) => c.server_id === null));
        assert.ok(history.some((c) => c.username === 'member'));
        const [[self]] = await db.execute("SELECT id FROM users WHERE username='admin'");
        assert.equal(
          (
            await admin.req('/users/' + self.id, 'PUT', {
              username: 'admin',
              display_name: 'Admin',
              role: 'member',
              active: false,
              permissions: emptyPermissions,
            })
          ).status,
          400,
        );
        await admin.req('/users/' + memberId, 'PUT', {
          username: 'member',
          display_name: 'Member',
          role: 'member',
          active: false,
          permissions: emptyPermissions,
        });
        assert.equal((await member.req('/servers')).status, 401);
        assert.equal(
          (
            await member.req('/auth/login', 'POST', {
              username: 'member',
              password: 'member-test-password',
            })
          ).status,
          401,
        );
      });
      await t.test('公网域名、HTTPS、来源和安全 Cookie 检查', async () => {
        const publicApp = createApp({
          db,
          key,
          bridge,
          config: {
            production: true,
            publicUrl: 'https://ops.example.com',
            secureCookie: true,
            proxy: 'loopback',
            bootstrapToken: 'a'.repeat(32),
          },
        });
        const publicServer = await new Promise((resolve) => {
          const s = publicApp.listen(0, '127.0.0.1', () => resolve(s));
        });
        const req = (headers, body) =>
          new Promise((resolve, reject) => {
            const r = httpRequest(
              {
                host: '127.0.0.1',
                port: publicServer.address().port,
                path: '/api/auth/login',
                method: 'POST',
                headers: {
                  Host: 'ops.example.com',
                  'Content-Type': 'application/json',
                  'X-Server-Harbor': '1',
                  ...headers,
                },
              },
              (res) => {
                let raw = '';
                res.on('data', (c) => (raw += c));
                res.on('end', () =>
                  resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) }),
                );
              },
            );
            r.on('error', reject);
            r.end(JSON.stringify(body));
          });
        try {
          assert.equal((await req({}, {})).status, 403);
          assert.equal(
            (await req({ 'X-Forwarded-Proto': 'https', Origin: 'https://evil.example' }, {}))
              .status,
            403,
          );
          const r = await req(
            { 'X-Forwarded-Proto': 'https', Origin: 'https://ops.example.com' },
            { username: 'admin', password: 'management-password' },
          );
          assert.equal(r.status, 200);
          assert.match(r.headers['set-cookie'][0], /__Host-harbor_session=/);
          assert.match(r.headers['set-cookie'][0], /Secure/);
          assert.match(r.headers['set-cookie'][0], /HttpOnly/);
        } finally {
          publicApp.harborClose();
          publicServer.closeAllConnections();
          await new Promise((r) => publicServer.close(r));
        }
      });
    } finally {
      app.harborClose();
      http.closeAllConnections();
      await new Promise((r) => http.close(r));
      await bridge.close();
      await mock.close();
      await new Promise((r) => setTimeout(r, 100));
      await clean(db);
      await db.end();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
