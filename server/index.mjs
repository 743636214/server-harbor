import { loadEnvironment } from './secrets.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDatabase } from './db.mjs';
import { createBridge } from './ssh.mjs';
import { createApp } from './app.mjs';
import { readConfig } from './config.mjs';
import { permissionsFor, transaction } from './permissions.mjs';
import { writeAudit } from './audit.mjs';
import { createRecording } from './recordings.mjs';
import { attachWebTerminals } from './web-terminal.mjs';
export async function start() {
  const env = await loadEnvironment();
  if (!/^[a-f0-9]{64}$/i.test(env.VAULT_KEY || ''))
    throw new Error('请先配置 VAULT_KEY（保留原项目主密钥）');
  const config = readConfig(env),
    db = await createDatabase(env),
    rootDir = fileURLToPath(new URL('../', import.meta.url)),
    key = Buffer.from(env.VAULT_KEY, 'hex'),
    recordingDir = path.join(rootDir, '.data/recordings');
  const bridge = await createBridge({
    port: Number(env.BRIDGE_PORT || 4320),
    host: config.gatewayBind,
    publicHost: config.gatewayHost,
    publicPort: config.gatewayPort,
    dataDir: path.join(rootDir, '.data'),
    vaultKey: key,
    authorize: async (meta) => {
      if (!meta.user?.id) return false;
      const [[user]] = await db.execute(
        'SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND s.token_hash=? AND s.expires_at>UTC_TIMESTAMP()',
        [meta.user.id, meta.sessionHash],
      );
      return Boolean(user?.active && permissionsFor(user)['server.connect']);
    },
    record: config.recording
      ? (ticket, onFailure) =>
          createRecording({
            db,
            key,
            dir: recordingDir,
            id: ticket.id,
            user: ticket.meta.user,
            server: ticket.server,
            maxBytes: config.recordingLimit,
            onFailure,
          })
      : null,
    onStatus: async (id, serverId, status, message, meta) =>
      transaction(db, async (store) => {
        const [[row]] = await store.execute('SELECT * FROM connections WHERE id=? FOR UPDATE', [
          id,
        ]);
        if (
          !row ||
          row.status === 'failed' ||
          (row.status === 'closed' && status !== 'failed') ||
          row.status === status
        )
          return;
        await store.execute('UPDATE connections SET status=?,message=? WHERE id=?', [
          status,
          message,
          id,
        ]);
        if (status === 'connected')
          await store.execute('UPDATE servers SET last_connected_at=UTC_TIMESTAMP() WHERE id=?', [
            serverId,
          ]);
        await writeAudit(store, {
          user: meta.user,
          server: { id: serverId, name: row.server_name },
          ip: meta.ip,
          action: 'ssh.' + status,
          outcome: status === 'failed' ? 'failed' : 'success',
          details: { connectionId: id, ...(message ? { message } : {}) },
        });
      }),
  });
  const app = createApp({ db, key, bridge, rootDir, config, recordingDir });
  const http = await new Promise((resolve, reject) => {
    const server = app.listen(Number(env.PORT || 4317), config.host, () => resolve(server));
    server.once('error', reject);
  });
  const terminals = attachWebTerminals({ http, app, bridge });
  console.log(
    `Server Harbor v2: ${config.publicUrl} | SSH gateway ${config.gatewayHost}:${config.gatewayPort}`,
  );
  const close = async () => {
    app.harborClose();
    await terminals.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    await bridge.close();
    await db.end();
  };
  process.once('SIGINT', () => close().then(() => process.exit()));
  process.once('SIGTERM', () => close().then(() => process.exit()));
  return { app, http, bridge, db, close };
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  start().catch((error) => {
    console.error('启动失败：' + (error.code || error.message));
    process.exit(1);
  });
