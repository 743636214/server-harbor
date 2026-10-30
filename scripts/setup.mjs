import mysql from 'mysql2/promise';
import { randomBytes, createHash } from 'node:crypto';
import { storeKeychain } from '../server/secrets.mjs';
import { writeFile, access } from 'node:fs/promises';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url)),
  test = process.argv.includes('--test');
const envFile = path.join(root, test ? '.env.test' : '.env');
try {
  await access(envFile);
  console.log('配置文件已存在，未作修改。');
  process.exit(0);
} catch {}
const database = test ? 'server_harbor_test' : 'server_harbor',
  user = database;
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});
process.stdout.write(`初始化本机 MySQL 的 ${database} 数据库，需要 root 密码（输入隐藏）：`);
rl._writeToOutput = () => {};
const password = await new Promise((resolve) => rl.question('', resolve));
rl.close();
process.stdout.write('\n');
let db;
try {
  db = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password,
    connectTimeout: 5000,
  });
  const [schemas] = await db.execute(
    'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',
    [database],
  );
  const [users] = await db.execute('SELECT User FROM mysql.user WHERE User=?', [user]);
  if (schemas.length || users.length)
    throw new Error('同名数据库或用户已存在，停止初始化以保护现有数据。请手动配置 .env。');
  const appPassword = randomBytes(32).toString('hex'),
    key = randomBytes(32).toString('hex');
  const account = 'config-' + createHash('sha256').update(envFile).digest('hex').slice(0, 32);
  await storeKeychain(account, { MYSQL_PASSWORD: appPassword, VAULT_KEY: key });
  await db.query(
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await db.query(`CREATE USER '${user}'@'127.0.0.1' IDENTIFIED BY '${appPassword}'`);
  await db.query(`CREATE USER '${user}'@'localhost' IDENTIFIED BY '${appPassword}'`);
  await db.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, REFERENCES ON \`${database}\`.* TO '${user}'@'127.0.0.1'`,
  );
  await db.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, REFERENCES ON \`${database}\`.* TO '${user}'@'localhost'`,
  );
  const [[socket]] = await db.query('SELECT @@socket AS socket');
  await writeFile(
    envFile,
    `PORT=4317\nBRIDGE_PORT=4320\nMYSQL_HOST=127.0.0.1\nMYSQL_PORT=3306\nMYSQL_SOCKET_PATH=${socket.socket}\nMYSQL_USER=${user}\nMYSQL_DATABASE=${database}\nHARBOR_KEYCHAIN_ACCOUNT=${account}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log('数据库和专用账号已创建；密码与主密钥保存在系统钥匙串，配置只保存引用。');
} catch (error) {
  console.error('初始化失败：' + (error.code || error.message));
  process.exitCode = 1;
} finally {
  await db?.end();
}
