import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionsFor } from '../server/permissions.mjs';
import { readConfig } from '../server/config.mjs';
import { changes } from '../server/audit.mjs';
test('权限默认拒绝、分别授权，管理员拥有完整权限', () => {
  assert.deepEqual(permissionsFor({ role: 'member' }), {
    'server.create': false,
    'server.edit': false,
    'server.delete': false,
    'server.connect': false,
    'cloud.manage': false,
  });
  const user = { role: 'member', permissions: JSON.stringify({ 'server.edit': true }) };
  assert.equal(permissionsFor(user)['server.edit'], true);
  assert.equal(permissionsFor(user)['server.delete'], false);
  assert.ok(Object.values(permissionsFor({ role: 'admin' })).every(Boolean));
});
test('公网配置拒绝 HTTP、本机网关及不受控录制容量', () => {
  assert.throws(() => readConfig({ NODE_ENV: 'production' }));
  assert.throws(() =>
    readConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://ops.example.com' }),
  );
  assert.throws(() => readConfig({ RECORDING_MAX_BYTES: 'NaN' }));
  const config = readConfig({
    NODE_ENV: 'production',
    PUBLIC_URL: 'https://ops.example.com',
    SSH_PUBLIC_HOST: 'ops.example.com',
    SSH_PUBLIC_PORT: '2222',
    TRUST_PROXY: 'loopback',
  });
  assert.equal(config.secureCookie, true);
  assert.equal(config.gatewayPort, 2222);
  assert.equal(config.proxy, 'loopback');
});
test('管理操作差异不泄露 SSH 密码、私钥、私钥口令或备注正文', () => {
  const diff = changes(
    { name: 'old', notes: 'old' },
    {
      name: 'new',
      password: 'ssh-password-value',
      privateKey: 'private-key-value',
      passphrase: 'secret-phrase',
      notes: 'sensitive notes',
    },
  );
  const text = JSON.stringify(diff);
  for (const secret of [
    'ssh-password-value',
    'private-key-value',
    'secret-phrase',
    'sensitive notes',
  ])
    assert.ok(!text.includes(secret));
  assert.equal(diff.credentialsUpdated, true);
  assert.equal(diff.notesChanged, true);
  assert.deepEqual(diff.name, { from: 'old', to: 'new' });
});
