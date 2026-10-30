import { readFile, readdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { loadEnvironment, secretNames } from '../server/secrets.mjs';
import { decrypt } from '../server/crypto.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = process.env.HARBOR_SCAN_ROOT || fileURLToPath(new URL('../', import.meta.url));
const env = await loadEnvironment({ file: path.join(root, '.env'), env: {} });
const key = Buffer.from(env.VAULT_KEY, 'hex');
const needles = new Set(
  Object.entries(env)
    .filter(([name]) => secretNames.includes(name))
    .map(([, value]) => value)
    .filter(Boolean),
);
const db = await mysql.createConnection({
  socketPath: env.MYSQL_SOCKET_PATH,
  host: env.MYSQL_HOST,
  port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
});
let credentials = 0,
  hashes = 0,
  files = 0,
  shortPasswords = 0;
const findings = [];
const includeSecrets = (value) => {
  for (const secret of Object.values(value))
    if (typeof secret === 'string' && secret.length >= 8) needles.add(secret);
};
try {
  const [servers] = await db.query('SELECT id,credentials FROM servers');
  for (const row of servers) {
    const value = decrypt(row.credentials, key, row.id);
    includeSecrets(value);
    credentials++;
    if (value.password && value.password.length < 12) shortPasswords++;
  }
  const [cloud] = await db.query('SELECT id,credentials FROM cloud_credentials');
  for (const row of cloud) {
    includeSecrets(decrypt(row.credentials, key, 'cloud:' + row.id));
    credentials++;
  }
  const [users] = await db.query('SELECT password_hash FROM users');
  for (const row of users) {
    if (
      !/^(?:scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}|[a-f0-9]{32}:[a-f0-9]{128})$/.test(
        row.password_hash,
      )
    )
      findings.push({ kind: 'invalid-account-hash' });
    hashes++;
  }
  const [audit] = await db.query('SELECT details FROM audit_events');
  for (const row of audit) {
    const text = typeof row.details === 'string' ? row.details : JSON.stringify(row.details);
    if ([...needles].some((secret) => text.includes(secret)))
      findings.push({ kind: 'audit-secret' });
  }
} finally {
  await db.end();
}
const scanBytes = (bytes, file) => {
  if ([...needles].some((secret) => bytes.includes(Buffer.from(secret))))
    findings.push({ kind: 'plaintext-secret', file });
};
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(file);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await lstat(file);
    if (stat.size > 67108864) {
      findings.push({ kind: 'file-not-scanned-size', file });
      continue;
    }
    const bytes = await readFile(file);
    files++;
    scanBytes(bytes, file);
    if (/^\.env(?:\.|$)/.test(entry.name) && !entry.name.endsWith('.example')) {
      const config = dotenv.parse(bytes);
      if (secretNames.some((name) => config[name])) findings.push({ kind: 'plaintext-env', file });
    }
    if (entry.name.endsWith('.pem') && /PRIVATE KEY/.test(bytes.toString()))
      findings.push({ kind: 'unencrypted-private-key', file });
    if (entry.name.endsWith('.tar.gz')) {
      const { stdout } = await exec('tar', ['-xOf', file], {
        encoding: 'buffer',
        maxBuffer: 67108864,
      });
      scanBytes(stdout, file);
    }
  }
}
await walk(root);
for (const dir of process.argv.slice(2)) await walk(path.resolve(dir));
console.log(
  JSON.stringify(
    {
      filesScanned: files,
      encryptedCredentialsChecked: credentials,
      passwordHashesChecked: hashes,
      shortRemotePasswords: shortPasswords,
      findings,
    },
    null,
    2,
  ),
);
if (findings.length) process.exitCode = 1;
