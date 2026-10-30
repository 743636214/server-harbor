import { readFile, writeFile, unlink, access, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { loadEnvironment, migrateEnvFile } from '../server/secrets.mjs';
import { encrypt, decrypt } from '../server/crypto.mjs';
import { encryptBackup, readBackup } from '../server/backup-crypto.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((file) => path.resolve(file))
  : [path.join(root, '.env'), path.join(root, '.env.test')];
let migrated = 0,
  keys = 0,
  backups = 0;
for (const file of files) {
  try {
    await access(file);
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  const env = await loadEnvironment({ file, env: {}, allowLegacy: true });
  let socketPath = env.MYSQL_SOCKET_PATH;
  if (!socketPath && ['localhost', '127.0.0.1'].includes(env.MYSQL_HOST)) {
    const db = await mysql.createConnection({
      host: env.MYSQL_HOST,
      port: Number(env.MYSQL_PORT || 3306),
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database: env.MYSQL_DATABASE,
    });
    try {
      const [[row]] = await db.query('SELECT @@socket AS socket');
      socketPath = row.socket;
    } finally {
      await db.end();
    }
  }
  if (await migrateEnvFile(file, { socketPath })) migrated++;
  if (path.basename(file) !== '.env') continue;
  const legacy = path.join(path.dirname(file), '.data/bridge-host-key.pem');
  let original;
  try {
    original = await readFile(legacy, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = Buffer.from(env.VAULT_KEY, 'hex'),
    destination = legacy.replace(/\.pem$/, '.enc');
  if (original) {
    const encoded = encrypt({ privateKey: original }, key, 'ssh-gateway-host-key:v1');
    try {
      await writeFile(destination, encoded, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (
      decrypt(await readFile(destination, 'utf8'), key, 'ssh-gateway-host-key:v1').privateKey !==
      original
    )
      throw new Error('网关私钥迁移验证失败，未删除原文件');
    await unlink(legacy);
    keys++;
  }
  const backupDir = path.join(path.dirname(file), '.data/backups');
  const names = await readdir(backupDir).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of names.filter((name) => name.endsWith('.sql'))) {
    const source = path.join(backupDir, name),
      target = source + '.enc';
    try {
      await encryptBackup(createReadStream(source), target, key);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (!(await readBackup(target, key)).equals(await readFile(source)))
      throw new Error('备份加密验证失败，未删除原文件');
    await unlink(source);
    backups++;
  }
}
console.log(
  `秘密迁移完成：${migrated} 份配置已移入系统钥匙串，${keys} 个网关私钥、${backups} 份旧 SQL 备份已加密。未输出秘密，主密钥及主机指纹保持不变。`,
);
