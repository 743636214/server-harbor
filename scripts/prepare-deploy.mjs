import { writeFile, access } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { loadEnvironment, storeKeychain } from '../server/secrets.mjs';
const domain = process.argv[2];
if (
  !domain ||
  !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/.test(domain)
)
  throw new Error('用法：npm run prepare:deploy -- ops.example.com');
try {
  await access('.env.production');
  throw new Error('.env.production 已存在，未覆盖');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const existing = await loadEnvironment();
const account = 'deployment-' + randomUUID();
await storeKeychain(account, {
  MYSQL_ROOT_PASSWORD: randomBytes(32).toString('hex'),
  MYSQL_APP_PASSWORD: randomBytes(32).toString('hex'),
  VAULT_KEY: existing.VAULT_KEY || randomBytes(32).toString('hex'),
  BOOTSTRAP_TOKEN: randomBytes(32).toString('hex'),
});
await writeFile(
  '.env.production',
  `APP_DOMAIN=${domain.toLowerCase()}\nSSH_PUBLIC_PORT=2222\nRECORDING_MAX_BYTES=33554432\n`,
  { mode: 0o600, flag: 'wx' },
);
console.log(
  '已生成不含秘密的部署配置；部署秘密保存在 macOS 钥匙串 ' +
    account +
    '。部署前必须配置外部秘密提供程序，不能将密码写入 Compose 或 env 文件。',
);
