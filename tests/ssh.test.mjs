import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { inspectFingerprint, connectRemote, createBridge } from '../server/ssh.mjs';

export async function mockSSH() {
  const makeKey = () =>
    generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey;
  const hostKey = makeKey(),
    privateKey = makeKey(),
    parsed = ssh2.utils.parseKey(privateKey);
  let authCount = 0,
    authenticationRequests = 0;
  const clients = new Set(),
    server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      clients.add(client);
      client.on('error', () => {});
      client.on('close', () => clients.delete(client));
      client.on('authentication', (ctx) => {
        authenticationRequests++;
        if (ctx.method === 'none') return ctx.reject(['password', 'publickey']);
        authCount++;
        if (ctx.username !== 'test-user') return ctx.reject();
        if (ctx.method === 'password' && ctx.password === 'ssh-test-password') return ctx.accept();
        if (
          ctx.method === 'publickey' &&
          ctx.key.data.equals(parsed.getPublicSSH()) &&
          (!ctx.signature || parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo))
        )
          return ctx.accept();
        ctx.reject(['password', 'publickey']);
      });
      client.on('ready', () =>
        client.on('session', (accept) => {
          const session = accept();
          session.on('pty', (acceptPty) => acceptPty());
          session.on('window-change', (acceptWindow) => acceptWindow?.());
          session.on('shell', (acceptShell) => {
            const channel = acceptShell();
            channel.write('CONNECTED:test-user\n');
            channel.on('data', (d) => channel.write('ECHO:' + d.toString()));
          });
        }),
      );
    });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    host: '127.0.0.1',
    port: server.address().port,
    username: 'test-user',
    auth_type: 'password',
    hostKey,
    privateKey,
    authCount: () => authCount,
    authenticationRequests: () => authenticationRequests,
    async close() {
      for (const c of clients) c.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
export async function throughBridge(url) {
  const data = new URLSearchParams(new URL(decodeURI(url)).hash.slice(1));
  const client = new ssh2.Client();
  client.on('error', () => {});
  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.connect({
      host: '127.0.0.1',
      port: Number(data.get('port')),
      username: decodeURIComponent(data.get('username')),
      hostVerifier: () => true,
      readyTimeout: 5000,
    });
  });
  const channel = await new Promise((resolve, reject) =>
    client.shell({ term: 'xterm', cols: 120, rows: 40 }, (err, s) =>
      err ? reject(err) : resolve(s),
    ),
  );
  let output = '';
  channel.on('data', (d) => {
    output += d;
  });
  channel.write('hello\n');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSH relay timed out: ' + output)), 5000);
    const poll = setInterval(() => {
      if (output.includes('ECHO:hello')) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 20);
    timer.unref();
  });
  channel.setWindow(50, 130, 0, 0);
  channel.close();
  client.end();
  return output;
}
if (import.meta.url === new URL('file://' + process.argv[1]).href)
  test('真实 SSH 协议验证密码、私钥、指纹保护与 Termius 桥接', { timeout: 30000 }, async () => {
    const mock = await mockSSH(),
      dataDir = await mkdtemp(path.join(tmpdir(), 'harbor-ssh-')),
      states = [];
    const bridge = await createBridge({
      port: 0,
      dataDir,
      vaultKey: randomBytes(32),
      onStatus: async (...args) => states.push(args),
    });
    try {
      const pinned = await inspectFingerprint(mock);
      assert.match(pinned, /^SHA256:/);
      assert.equal(mock.authCount(), 0);
      await assert.rejects(
        connectRemote({ ...mock, fingerprint: 'SHA256:wrong' }, { password: 'ssh-test-password' }),
        (e) => e.code === 'HOST_KEY_CHANGED',
      );
      assert.equal(mock.authCount(), 0);
      await assert.rejects(
        connectRemote({ ...mock, fingerprint: pinned }, { password: 'wrong-password' }),
      );
      for (const auth_type of ['password', 'key']) {
        const row = { ...mock, id: 'server-1', name: 'SSH test', auth_type, fingerprint: pinned };
        const remote = await connectRemote(row, {
          password: 'ssh-test-password',
          privateKey: mock.privateKey,
        });
        const { url } = await bridge.launch(remote, row, 'connection-' + auth_type, true);
        assert.match(await throughBridge(url), /CONNECTED:test-user/);
        await assert.rejects(throughBridge(url));
      }
      assert.ok(states.some((s) => s[2] === 'connected'));
    } finally {
      await bridge.close();
      await mock.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
