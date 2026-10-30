import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { encrypt, decrypt } from './crypto.mjs';

export async function createRecording({
  db,
  key,
  dir,
  id,
  user,
  server,
  maxBytes = 33554432,
  onFailure,
}) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid recording id');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const output = createWriteStream(path.join(dir, id + '.jsonl'), { flags: 'wx', mode: 0o600 });
  await new Promise((resolve, reject) => {
    output.once('open', resolve);
    output.once('error', reject);
  });
  await db.execute(
    'INSERT INTO recordings(connection_id,user_id,username,server_name) VALUES (?,?,?,?)',
    [id, user.id, user.username, server.name],
  );
  const start = Date.now(),
    hash = createHash('sha256');
  let seq = 0,
    bytes = 0,
    closing = false,
    failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    onFailure?.();
  };
  output.on('error', fail);
  return {
    write(type, chunk, source) {
      if (closing || failed) return;
      const data = Buffer.from(chunk),
        time = Date.now() - start;
      if (bytes + data.length > maxBytes) {
        fail();
        return;
      }
      bytes += data.length;
      const body = encrypt({ t: time, type, data: data.toString('base64') }, key, `${id}:${seq}`);
      const line = JSON.stringify({ seq: seq++, body }) + '\n';
      hash.update(line);
      if (!output.write(line) && source?.pause) {
        source.pause();
        output.once('drain', () => source.resume());
      }
    },
    async close() {
      if (closing) return;
      closing = true;
      await new Promise((resolve) => {
        if (output.destroyed) return resolve();
        output.once('close', resolve);
        output.end();
      });
      await db.execute(
        'UPDATE recordings SET state=?,byte_count=?,chunk_count=?,sha256=?,ended_at=UTC_TIMESTAMP(3) WHERE connection_id=?',
        [failed ? 'failed' : 'complete', bytes, seq, hash.digest('hex'), id],
      );
    },
  };
}
export async function readRecording({ id, dir, key, from = 0, limit = 200, meta }) {
  if (!dir || !/^[0-9a-f-]{36}$/.test(id))
    throw Object.assign(new Error('录制文件不可用'), { status: 404 });
  const input = createReadStream(path.join(dir, id + '.jsonl'));
  const reader = createInterface({ input, crlfDelay: Infinity }),
    hash = createHash('sha256'),
    events = [];
  let seq = 0,
    payloadBytes = 0;
  try {
    for await (const line of reader) {
      if (!line) continue;
      let outer;
      try {
        outer = JSON.parse(line);
      } catch (error) {
        if (meta.state === 'recording') break;
        throw error;
      }
      if (outer.seq !== seq) throw new Error('Recording sequence mismatch');
      hash.update(line + '\n');
      const payload = decrypt(outer.body, key, `${id}:${seq}`);
      if (seq >= from && events.length < limit && payloadBytes < 1048576) {
        events.push({ ...payload, seq });
        payloadBytes += Buffer.byteLength(payload.data);
      }
      seq++;
    }
    const checksum = hash.digest('hex');
    if (meta.state === 'complete' && (Number(meta.chunk_count) !== seq || meta.sha256 !== checksum))
      throw new Error('Recording checksum mismatch');
    return {
      events,
      next: events.length ? events.at(-1).seq + 1 : from,
      total: seq,
      hasMore: events.length > 0 && events.at(-1).seq + 1 < seq,
      verified: meta.state === 'complete',
    };
  } catch (error) {
    if (error.code === 'ENOENT')
      throw Object.assign(new Error('录制文件丢失，请检查数据卷或备份'), { status: 410 });
    throw Object.assign(new Error('会话录制完整性验证失败，已停止回放'), { status: 409 });
  } finally {
    reader.close();
    input.destroy();
  }
}
