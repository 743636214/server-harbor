import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { pipeline, finished } from 'node:stream/promises';
const magic = Buffer.from('HARBORBACKUP1\n');
export async function encryptBackup(input, destination, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(magic);
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const completion = finished(output);
  completion.catch(() => {});
  try {
    output.write(Buffer.concat([magic, iv]));
    await pipeline(input, cipher, output, { end: false });
    output.end(cipher.getAuthTag());
    await completion;
  } catch (error) {
    output.destroy();
    await completion.catch(() => {});
    if (error.code !== 'EEXIST') await unlink(destination).catch(() => {});
    throw error;
  }
}
export async function readBackup(file, key) {
  const data = await readFile(file),
    offset = magic.length + 12;
  if (data.length < offset + 16 || !data.subarray(0, magic.length).equals(magic))
    throw new Error('备份格式不正确');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(magic.length, offset));
  decipher.setAAD(magic);
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(offset, -16)), decipher.final()]);
}
