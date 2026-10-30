import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createServer as tcpServer, connect as tcpConnect } from 'node:net';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import ssh2 from 'ssh2';
import { loadEnvironment } from '../server/secrets.mjs';
import { createDatabase } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { hashPassword, verifyPassword, encrypt, decrypt } from '../server/crypto.mjs';
import { createLimiter } from '../server/rate-limit.mjs';
import { readConfig } from '../server/config.mjs';
import { createBridge, inspectFingerprint, connectRemote } from '../server/ssh.mjs';
import { attachWebTerminals } from '../server/web-terminal.mjs';
import { encryptBackup, readBackup } from '../server/backup-crypto.mjs';
import { mockSSH } from './ssh.test.mjs';
const exec = promisify(execFile);
const listen = (server) =>
  new Promise((resolve) => {
    const actual = server.listen(0, '127.0.0.1', () => resolve(actual));
  });
const stop = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function proxyTo(target) {
  const packets = [],
    sockets = new Set();
  const server = await listen(
    tcpServer((incoming) => {
      const outgoing = tcpConnect(target.address().port, '127.0.0.1');
      for (const socket of [incoming, outgoing]) {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', (chunk) => packets.push(Buffer.from(chunk)));
      }
      incoming.pipe(outgoing).pipe(incoming);
      incoming.on('close', () => outgoing.destroy());
      outgoing.on('close', () => incoming.destroy());
    }),
  );
  return {
    port: server.address().port,
    captured: () => Buffer.concat(packets),
    async close() {
      for (const socket of sockets) socket.destroy();
      await stop(server);
    },
  };
}
function wsOpen(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 5000 });
    ws.on('error', reject);
    ws.on('unexpected-response', (request, response) => {
      response.resume();
      ws.terminate();
      resolve({ status: response.statusCode });
    });
    ws.on('open', () => resolve({ status: 101, ws }));
  });
}
function rawRequest({
  port,
  secure = false,
  ca,
  servername,
  headers = {},
  body,
  route = '/api/auth/login',
}) {
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: body === undefined ? 'GET' : 'POST',
        ca,
        servername,
        headers: { 'Content-Type': 'application/json', 'X-Server-Harbor': '1', ...headers },
        timeout: 5000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(raw) }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function certificate() {
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  const cert = await new Promise((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn('/usr/bin/openssl', [
        'req',
        '-new',
        '-x509',
        '-key',
        '/dev/stdin',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ]);
      let stdout = '';
      child.stdout.on('data', (data) => (stdout += data));
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(stdout) : reject(new Error('Test certificate generation failed')),
      );
      child.stdin.end(key);
    });
  });
  return { key, cert };
}

test('加密、配置、哈希及并发限流边界', async () => {
  const key = randomBytes(32),
    dir = await mkdtemp(path.join(tmpdir(), 'harbor-security-unit-'));
  try {
    const secret = 'synthetic-backup-password-sentinel';
    const file = path.join(dir, 'backup.enc');
    await encryptBackup(Readable.from([secret]), file, key);
    assert.equal((await readBackup(file, key)).toString(), secret);
    assert.ok(!(await readFile(file)).includes(Buffer.from(secret)));
    await assert.rejects(readBackup(file, randomBytes(32)));
    const data = await readFile(file);
    data[data.length - 20] ^= 1;
    await writeFile(file, data);
    await assert.rejects(readBackup(file, key));
    const encoded = await hashPassword('test-management-password');
    assert.match(encoded, /^scrypt\$32768\$8\$3\$/);
    assert.equal(await verifyPassword('wrong', encoded), false);
    for (const malformed of ['', 'broken', ':', 'x:y', null])
      assert.equal(await verifyPassword('secret', malformed), false);
    const limiter = createLimiter({ maxKeys: 1 });
    assert.deepEqual(
      await Promise.all(
        Array.from({ length: 20 }, () => Promise.resolve(limiter.take('same-account', 8))),
      ),
      [...Array(8).fill(true), ...Array(12).fill(false)],
    );
    assert.equal(limiter.take('different-account', 8), false);
    assert.throws(() => readConfig({ HOST: '0.0.0.0' }));
    assert.throws(() => readConfig({ SSH_BIND_HOST: '0.0.0.0' }));
    assert.throws(() => readConfig({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }));
    assert.throws(() => readConfig({ TRUST_PROXY: '1' }));
    await assert.rejects(createDatabase({ MYSQL_HOST: 'db.example.test' }), /MySQL/);
    const config = path.join(dir, '.env');
    await writeFile(config, 'MYSQL_PASSWORD=synthetic-not-real\n');
    await assert.rejects(loadEnvironment({ file: config, env: {} }), /明文/);
    await rm(config);
    const record = encrypt({ password: secret }, key, 'one');
    assert.throws(() => decrypt(record, key, 'two'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  '隔离测试库：登录、权限、Cookie、WebSocket、TLS/SSH 中间人攻击',
  { timeout: 120000 },
  async (t) => {
    const env = await loadEnvironment({
      file: process.env.HARBOR_TEST_ENV_FILE || new URL('../.env.test', import.meta.url),
      env: {},
    });
    assert.equal(env.MYSQL_DATABASE, 'server_harbor_test');
    const db = await createDatabase(env),
      key = randomBytes(32),
      dir = await mkdtemp(path.join(tmpdir(), 'harbor-security-'));
    const clean = async () => {
      for (const table of [
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
      ])
        await db.query('DELETE FROM ' + table);
    };
    await clean();
    const mock = await mockSSH();
    const bridge = await createBridge({
      port: 0,
      dataDir: dir,
      vaultKey: key,
      authorize: async (meta) => {
        const [[row]] = await db.execute(
          'SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE u.id=? AND s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() AND u.active=TRUE',
          [meta.user.id, meta.sessionHash],
        );
        return !!row;
      },
    });
    const app = createApp({ db, key, bridge }),
      server = await listen(app);
    const terminals = attachWebTerminals({ http: server, app, bridge });
    const port = server.address().port;
    const account = 'securityadmin',
      password = 'security-login-password-sentinel';
    const req = (body, headers = {}, route) => rawRequest({ port, body, headers, route });
    let cookie, userId, serverId, cloudId;
    try {
      const setup = await req({ username: account, password }, {}, '/api/auth/setup');
      assert.equal(setup.status, 200);
      cookie = setup.headers['set-cookie'][0].split(';')[0];
      userId = setup.data.user.id;
      await t.test('管理密码只保存哈希，响应不泄露密码或数据库凭据', async () => {
        const [[user]] = await db.execute('SELECT * FROM users WHERE id=?', [userId]);
        assert.notEqual(user.password_hash, password);
        assert.ok(await verifyPassword(password, user.password_hash));
        assert.ok(!JSON.stringify(setup.data).includes(password));
        assert.match(setup.headers['set-cookie'][0], /HttpOnly/);
        assert.match(setup.headers['set-cookie'][0], /SameSite=Strict/);
        assert.equal((await req(undefined, {}, '/api/servers')).status, 401);
        assert.equal(
          (await req(undefined, { Cookie: 'harbor_session=' + 'a'.repeat(64) }, '/api/servers'))
            .status,
          401,
        );
      });
      await t.test('伪造域名、跨站请求、任意本机来源及 SQL 注入被拒绝', async () => {
        const credentials = { username: account, password };
        assert.equal((await req(credentials, { Host: 'evil.example' })).status, 403);
        assert.equal((await req(credentials, { Origin: 'https://evil.example' })).status, 403);
        assert.equal((await req(credentials, { Origin: 'http://localhost:9999' })).status, 403);
        assert.equal((await req(credentials, { 'X-Server-Harbor': '' })).status, 403);
        assert.equal((await req(credentials, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
        assert.equal((await req({ username: "' OR 1=1 --", password })).status, 401);
      });
      await t.test('并发猜密码五次即锁定，伪造代理 IP 不能绕过', async () => {
        const results = await Promise.all(
          Array.from({ length: 16 }, (_, i) =>
            req(
              { username: 'bruteforce', password: 'wrong-password' },
              { 'X-Forwarded-For': '203.0.113.' + i },
            ),
          ),
        );
        assert.equal(results.filter((result) => result.status === 401).length, 4);
        assert.equal(results.filter((result) => result.status === 429).length, 12);
      });
      await t.test('SSH/云秘密只存密文且不会通过列表或日志回传', async () => {
        const headers = { Cookie: cookie };
        const result = await req(
          {
            name: 'Security test',
            host: mock.host,
            port: mock.port,
            username: mock.username,
            auth_type: 'password',
            password: 'ssh-test-password',
            environment: 'development',
          },
          headers,
          '/api/servers',
        );
        assert.equal(result.status, 201);
        serverId = result.data.id;
        const fp = await req({}, headers, `/api/servers/${serverId}/fingerprint`);
        assert.equal(
          (await req({ ticket: fp.data.ticket }, headers, `/api/servers/${serverId}/trust`)).status,
          200,
        );
        const cloud = await req(
          {
            name: 'Synthetic account',
            provider: 'aws',
            accessKeyId: 'synthetic-access-id',
            secretAccessKey: 'synthetic-cloud-secret-sentinel',
          },
          headers,
          '/api/cloud/credentials',
        );
        assert.equal(cloud.status, 201);
        cloudId = cloud.data.id;
        const [[row]] = await db.execute('SELECT credentials FROM servers WHERE id=?', [serverId]);
        const [[cloudRow]] = await db.execute(
          'SELECT credentials FROM cloud_credentials WHERE id=?',
          [cloudId],
        );
        assert.ok(!row.credentials.includes('ssh-test-password'));
        assert.ok(!cloudRow.credentials.includes('synthetic-cloud-secret-sentinel'));
        for (const route of ['/api/servers', '/api/cloud/credentials', '/api/audit']) {
          const text = JSON.stringify((await req(undefined, headers, route)).data);
          for (const secret of ['ssh-test-password', 'synthetic-cloud-secret-sentinel', password])
            assert.ok(!text.includes(secret));
        }
        const member = await req(
          {
            username: 'readonlyuser',
            display_name: 'Readonly',
            role: 'member',
            password: 'readonly-test-password',
            permissions: {
              'server.create': false,
              'server.edit': false,
              'server.delete': false,
              'server.connect': false,
              'cloud.manage': false,
            },
          },
          headers,
          '/api/users',
        );
        assert.equal(member.status, 201);
        const login = await req({ username: 'readonlyuser', password: 'readonly-test-password' });
        const memberCookie = login.headers['set-cookie'][0].split(';')[0];
        assert.equal(
          (await req(undefined, { Cookie: memberCookie }, '/api/cloud/credentials')).status,
          403,
        );
        assert.equal((await req(undefined, { Cookie: memberCookie }, '/api/users')).status, 403);
        const denied = await wsOpen(`ws://127.0.0.1:${port}/terminal`, {
          Cookie: memberCookie,
          Origin: `http://127.0.0.1:${port}`,
        });
        assert.equal(denied.status, 401);
      });
      await t.test('WebSocket 拒绝跨站、未登录和伪造会话，合法网页 SSH 可用', async () => {
        const url = `ws://127.0.0.1:${port}/terminal`,
          origin = `http://127.0.0.1:${port}`;
        assert.equal(
          (await wsOpen(url, { Cookie: cookie, Origin: 'https://evil.example' })).status,
          403,
        );
        assert.equal((await wsOpen(url, { Origin: origin })).status, 401);
        assert.equal(
          (await wsOpen(url, { Cookie: 'harbor_session=' + 'b'.repeat(64), Origin: origin }))
            .status,
          401,
        );
        const ticket = await req(
          { client: 'web' },
          { Cookie: cookie },
          `/api/servers/${serverId}/connect`,
        );
        assert.equal(ticket.status, 200);
        const { ws } = await wsOpen(url, { Cookie: cookie, Origin: origin });
        const output = await new Promise((resolve, reject) => {
          let text = '';
          const timeout = setTimeout(() => reject(new Error('Web SSH timeout')), 5000);
          ws.on('error', reject);
          ws.on('message', (data, binary) => {
            if (binary) {
              text += data;
              if (text.includes('ECHO:wire-test')) {
                clearTimeout(timeout);
                resolve(text);
              }
            } else {
              const m = JSON.parse(data);
              if (m.type === 'ready') ws.send(Buffer.from('wire-test\n'));
              if (m.type === 'error') reject(new Error(m.message));
            }
          });
          ws.send(
            JSON.stringify({ type: 'open', token: ticket.data.webToken, cols: 100, rows: 30 }),
          );
        });
        assert.match(output, /CONNECTED/);
        ws.close();
        assert.equal(await app.harborTakeWebTicket(ticket.data.webToken, { id: userId }), null);
        await pause();
      });
      await t.test('退出后旧 Cookie 与待接入 SSH 票据均无法重放', async () => {
        const pending = await req(
          { client: 'web' },
          { Cookie: cookie },
          `/api/servers/${serverId}/connect`,
        );
        assert.equal(pending.status, 200);
        const logout = await req({}, { Cookie: cookie }, '/api/auth/logout');
        assert.equal(logout.status, 200);
        assert.equal((await req(undefined, { Cookie: cookie }, '/api/servers')).status, 401);
        assert.equal(await app.harborTakeWebTicket(pending.data.webToken, { id: userId }), null);
        const login = await req({ username: account, password });
        cookie = login.headers['set-cookie'][0].split(';')[0];
      });
      await t.test('HTTPS 抓包看不到登录密码/Cookie；伪造证书与错误域名失败', async () => {
        const identity = await certificate(),
          impostor = await certificate();
        const publicApp = createApp({
          db,
          key,
          bridge,
          config: { production: true, publicUrl: 'https://ops.example.com', secureCookie: true },
        });
        const tls = await listen(httpsServer(identity, publicApp)),
          proxy = await proxyTo(tls);
        let interceptedRequests = 0;
        const attacker = await listen(
          httpsServer(impostor, (request, response) => {
            interceptedRequests++;
            response.end('{}');
          }),
        );
        try {
          const headers = { Host: 'ops.example.com', Origin: 'https://ops.example.com' };
          const result = await rawRequest({
            port: proxy.port,
            secure: true,
            ca: identity.cert,
            servername: 'localhost',
            headers,
            body: { username: account, password },
          });
          assert.equal(result.status, 200);
          const session = result.headers['set-cookie'][0];
          assert.match(session, /__Host-harbor_session=/);
          assert.match(session, /Secure/);
          assert.match(session, /HttpOnly/);
          const traffic = proxy.captured();
          assert.ok(!traffic.includes(Buffer.from(password)));
          assert.ok(!traffic.includes(Buffer.from(session.split(';')[0])));
          await assert.rejects(
            rawRequest({
              port: attacker.address().port,
              secure: true,
              ca: identity.cert,
              servername: 'localhost',
              headers,
              body: { username: account, password },
            }),
            (error) =>
              [
                'DEPTH_ZERO_SELF_SIGNED_CERT',
                'CERT_SIGNATURE_FAILURE',
                'SELF_SIGNED_CERT_IN_CHAIN',
              ].includes(error.code),
          );
          assert.equal(interceptedRequests, 0);
          await assert.rejects(
            rawRequest({
              port: tls.address().port,
              secure: true,
              ca: identity.cert,
              servername: 'evil.example',
              headers,
              body: { username: account, password },
            }),
            (error) => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID',
          );
          assert.equal(
            (
              await rawRequest({
                port,
                headers: { Host: 'ops.example.com' },
                body: { username: account, password },
              })
            ).status,
            403,
          );
        } finally {
          publicApp.harborClose();
          await proxy.close();
          await stop(attacker);
          await stop(tls);
        }
      });
      await t.test('SSH 替换主机密钥时，在账号/密码认证前中止', async () => {
        const evil = await mockSSH();
        let authenticationRequests = 0;
        // mockSSH counts actual password/public-key authentication attempts.
        try {
          const pin = await inspectFingerprint(mock);
          await assert.rejects(
            connectRemote({ ...evil, fingerprint: pin }, { password: 'ssh-test-password' }),
            (error) => error.code === 'HOST_KEY_CHANGED',
          );
          authenticationRequests = evil.authenticationRequests();
          assert.equal(authenticationRequests, 0);
          const proxy = await proxyTo({ address: () => ({ port: mock.port }) });
          try {
            const remote = await connectRemote(
              { ...mock, port: proxy.port, fingerprint: pin },
              { password: 'ssh-test-password' },
            );
            const channel = await new Promise((resolve, reject) =>
              remote.shell((error, stream) => (error ? reject(error) : resolve(stream))),
            );
            await new Promise((resolve, reject) => {
              let output = '';
              const timeout = setTimeout(() => reject(new Error('SSH capture timeout')), 5000);
              channel.on('data', (data) => {
                output += data;
                if (output.includes('ECHO:ssh-wire-command-sentinel')) {
                  clearTimeout(timeout);
                  resolve();
                }
              });
              channel.write('ssh-wire-command-sentinel\n');
            });
            for (const secret of ['ssh-test-password', 'test-user', 'ssh-wire-command-sentinel'])
              assert.ok(!proxy.captured().includes(Buffer.from(secret)));
            channel.close();
            remote.end();
          } finally {
            await proxy.close();
          }
          const raw = await readFile(path.join(dir, 'bridge-host-key.enc'), 'utf8');
          assert.ok(!raw.includes('PRIVATE KEY'));
          await assert.rejects(readFile(path.join(dir, 'bridge-host-key.pem')));
        } finally {
          await evil.close();
        }
      });
    } finally {
      app.harborClose();
      await terminals.close();
      await stop(server);
      await bridge.close();
      await mock.close();
      await clean();
      await db.end();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
