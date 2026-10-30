import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCb);
const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
let passwordJobs = 0;
const passwordQueue = [];
async function derive(password, salt, options) {
  if (passwordJobs >= 4) {
    if (passwordQueue.length >= 32)
      throw Object.assign(new Error('登录请求过多，请稍后重试'), { status: 429 });
    await new Promise((resolve) => passwordQueue.push(resolve));
  } else passwordJobs++;
  try {
    return await scrypt(password, salt, 64, options);
  } finally {
    const next = passwordQueue.shift();
    if (next) next();
    else passwordJobs--;
  }
}
export function encrypt(value, key, id) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    body: body.toString('base64'),
  });
}
export function decrypt(value, key, id) {
  const data = JSON.parse(value),
    decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(data.body, 'base64')), decipher.final()]).toString(
      'utf8',
    ),
  );
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, passwordOptions);
  return `scrypt$32768$8$3$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128 || typeof encoded !== 'string')
    return false;
  let salt, hex, options;
  if (encoded.startsWith('scrypt$32768$8$3$')) {
    [, , , , salt, hex] = encoded.split('$');
    options = passwordOptions;
  } else {
    [salt, hex] = encoded.split(':');
    options = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
  }
  if (!/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(hex || '')) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = await derive(password, salt, options);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
