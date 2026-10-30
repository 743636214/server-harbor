import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, hashPassword, verifyPassword } from '../server/crypto.mjs';
import { serverSchema } from '../server/validation.mjs';
import { termiusLink } from '../server/ssh.mjs';
test('凭据加密使用独立随机 IV，并绑定服务器 ID', () => {
  const key = randomBytes(32),
    secrets = { password: 'secret-password', privateKey: 'secret-key' };
  const a = encrypt(secrets, key, 'server-a'),
    b = encrypt(secrets, key, 'server-a');
  assert.notEqual(a, b);
  assert.ok(!a.includes(secrets.password));
  assert.deepEqual(decrypt(a, key, 'server-a'), secrets);
  assert.throws(() => decrypt(a, key, 'server-b'));
  assert.throws(() => decrypt(a, randomBytes(32), 'server-a'));
  const changed = JSON.parse(a);
  changed.tag = randomBytes(16).toString('base64');
  assert.throws(() => decrypt(JSON.stringify(changed), key, 'server-a'));
});
test('管理密码使用随机盐与 scrypt 验证', async () => {
  const a = await hashPassword('secure-local-password'),
    b = await hashPassword('secure-local-password');
  assert.notEqual(a, b);
  assert.ok(await verifyPassword('secure-local-password', a));
  assert.equal(await verifyPassword('wrong-password', a), false);
});
test('拒绝主机命令注入并支持域名与 IPv6', () => {
  const data = {
    name: 'Test',
    host: 'example.com',
    port: 22,
    username: 'root',
    auth_type: 'password',
    environment: 'production',
  };
  assert.ok(serverSchema.safeParse(data).success);
  for (const host of [
    '127.0.0.1;touch /tmp/x',
    '$(id)',
    'https://example.com',
    'host:22',
    '--help',
    'a b',
  ])
    assert.equal(serverSchema.safeParse({ ...data, host }).success, false);
  assert.ok(serverSchema.safeParse({ ...data, host: '2001:db8::1' }).success);
  assert.equal(serverSchema.safeParse({ ...data, port: 65536 }).success, false);
});
test('Termius 链接保留中文和特殊字符，不包含 SSH 凭据', () => {
  const row = { name: '杭州 & 运维 #1 + %', username: 'root', host: 'example.com' };
  const value = termiusLink(row, 4320, 'ticket'),
    decoded = new URL(decodeURI(value)),
    hash = new URLSearchParams(decoded.hash.slice(1));
  assert.equal(decodeURIComponent(hash.get('label')), row.name + ' · root@example.com');
  assert.equal(decodeURIComponent(hash.get('username')), 'root--ticket');
  assert.equal(hash.get('ip'), '127.0.0.1');
});
