import { loadEnvironment } from '../server/secrets.mjs';
import { encryptBackup } from '../server/backup-crypto.mjs';
import { mkdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const env = await loadEnvironment(),
  key = Buffer.from(env.VAULT_KEY, 'hex');
const dir = path.resolve('.data/backups');
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = path.join(
  dir,
  'harbor-' + new Date().toISOString().replace(/[:.]/g, '-') + '.sql.enc',
);
const args = [
  '--single-transaction',
  '--skip-lock-tables',
  '--no-tablespaces',
  '--set-gtid-purged=OFF',
  ...(env.MYSQL_SOCKET_PATH
    ? ['--socket', env.MYSQL_SOCKET_PATH]
    : ['-h', env.MYSQL_HOST || '127.0.0.1', '-P', env.MYSQL_PORT || '3306']),
  '-u',
  env.MYSQL_USER,
  env.MYSQL_DATABASE || 'server_harbor',
];
const child = spawn('mysqldump', args, {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, MYSQL_PWD: env.MYSQL_PASSWORD },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.resume();
const exited = new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', resolve);
});
exited.catch(() => {});
try {
  await encryptBackup(child.stdout, file, key);
  if ((await exited) !== 0) throw new Error('mysqldump 失败');
} catch {
  child.kill();
  await unlink(file).catch(() => {});
  throw new Error('数据库加密备份失败，请检查 mysqldump 和数据库权限');
}
console.log('加密数据库备份已写入 ' + file + '；恢复需要系统钥匙串中的原 VAULT_KEY。');
