import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';

const exec = promisify(execFile);
export const secretNames = [
  'MYSQL_PASSWORD',
  'MYSQL_APP_PASSWORD',
  'MYSQL_ROOT_PASSWORD',
  'VAULT_KEY',
  'BOOTSTRAP_TOKEN',
];
const service = 'com.server-harbor.secrets';
const validAccount = (account) => /^[a-zA-Z0-9._:-]{1,160}$/.test(account);

export async function readKeychain(account) {
  if (process.platform !== 'darwin' || !validAccount(account))
    throw new Error('此配置需要 macOS 钥匙串；Linux 请由秘密管理器在启动时注入秘密');
  try {
    const { stdout } = await exec(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { maxBuffer: 1048576 },
    );
    const value = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('无法读取 Server Harbor 钥匙串秘密，请检查钥匙串是否解锁及访问权限');
  }
}

export async function storeKeychain(account, secrets) {
  if (process.platform !== 'darwin' || !validAccount(account))
    throw new Error('禁止把秘密写入配置文件；请使用 macOS 钥匙串或外部秘密管理器');
  const payload = Buffer.from(JSON.stringify(secrets)).toString('base64');
  if (payload.length > 3400) throw new Error('钥匙串秘密包过大，拒绝截断保存');
  // Interactive stdin keeps the secret out of process arguments and shell history.
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => reject(new Error('无法写入系统钥匙串')));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('无法写入系统钥匙串'))));
    child.stdin.on('error', () => {});
    child.stdin.end(`add-generic-password -U -s ${service} -a ${account} -w ${payload}\n`);
  });
  if (JSON.stringify(await readKeychain(account)) !== JSON.stringify(secrets))
    throw new Error('钥匙串写入验证失败，原配置未修改');
}

export async function loadEnvironment({
  file = path.resolve(process.env.DOTENV_CONFIG_PATH || '.env'),
  env = process.env,
  allowLegacy = false,
} = {}) {
  let config = {};
  try {
    config = dotenv.parse(await readFile(file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!allowLegacy && secretNames.some((name) => config[name]))
    throw new Error('检测到配置文件中的明文秘密，请先运行 npm run secrets:migrate');
  const reference = Object.hasOwn(env, 'HARBOR_KEYCHAIN_ACCOUNT')
    ? env.HARBOR_KEYCHAIN_ACCOUNT
    : config.HARBOR_KEYCHAIN_ACCOUNT;
  const secrets = reference ? await readKeychain(reference) : {};
  const provider = env.HARBOR_SECRET_PROVIDER || config.HARBOR_SECRET_PROVIDER;
  if (provider) {
    if (!path.isAbsolute(provider)) throw new Error('秘密提供程序必须使用可信的绝对路径');
    for (const name of ['MYSQL_PASSWORD', 'VAULT_KEY', 'BOOTSTRAP_TOKEN']) {
      try {
        const { stdout } = await exec(
          provider,
          [name === 'MYSQL_PASSWORD' ? 'MYSQL_APP_PASSWORD' : name],
          { maxBuffer: 65536, timeout: 10000 },
        );
        secrets[name] = stdout.replace(/\r?\n$/, '');
      } catch {
        throw new Error('无法从外部秘密管理器读取 ' + name);
      }
    }
  }
  return { ...config, ...secrets, ...env };
}

export async function migrateEnvFile(file, { socketPath } = {}) {
  const config = dotenv.parse(await readFile(file));
  const secrets = Object.fromEntries(
    secretNames.filter((name) => config[name]).map((name) => [name, config[name]]),
  );
  if (!Object.keys(secrets).length) return false;
  const account =
    config.HARBOR_KEYCHAIN_ACCOUNT ||
    'config-' + createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 32);
  const existing = config.HARBOR_KEYCHAIN_ACCOUNT ? await readKeychain(account) : {};
  await storeKeychain(account, { ...existing, ...secrets });
  for (const name of secretNames) delete config[name];
  config.HARBOR_KEYCHAIN_ACCOUNT = account;
  if (socketPath) config.MYSQL_SOCKET_PATH = socketPath;
  const temporary = file + '.migration-' + randomUUID();
  await writeFile(
    temporary,
    Object.entries(config)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join('\n') + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  await rename(temporary, file);
  await chmod(file, 0o600);
  return true;
}
