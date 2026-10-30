import ssh2 from 'ssh2';
import { randomBytes, generateKeyPairSync, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { encrypt, decrypt } from './crypto.mjs';
export const sshAlgorithms = {
  serverHostKey: { remove: ['ssh-rsa', 'ssh-dss'] },
  hmac: { remove: ['hmac-sha1', 'hmac-sha1-etm@openssh.com', 'hmac-md5'] },
};
const fingerprint = (key) =>
  'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
export function inspectFingerprint(server) {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let seen;
    client.on('error', (error) => (seen ? resolve(seen) : reject(error)));
    client.on('close', () =>
      seen ? resolve(seen) : reject(new Error('SSH closed before host key')),
    );
    client.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      algorithms: sshAlgorithms,
      readyTimeout: 10000,
      hostVerifier: (key) => {
        seen = fingerprint(key);
        return false;
      },
    });
  });
}
export function connectRemote(server, secrets) {
  return new Promise((resolve, reject) => {
    const remote = new ssh2.Client();
    let observed;
    remote.on('error', (error) => {
      if (observed && observed !== server.fingerprint) {
        error.code = 'HOST_KEY_CHANGED';
        error.observed = observed;
      }
      reject(error);
    });
    remote.once('ready', () => resolve(remote));
    remote.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      algorithms: sshAlgorithms,
      readyTimeout: 15000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      ...(server.auth_type === 'password'
        ? { password: secrets.password }
        : { privateKey: secrets.privateKey, passphrase: secrets.passphrase || undefined }),
      hostVerifier: (key) => {
        observed = fingerprint(key);
        return observed === server.fingerprint;
      },
    });
  });
}
export function termiusLink(server, port, token, publicHost = '127.0.0.1') {
  const values = {
    ip: publicHost,
    port: String(port),
    username: `${server.username}--${token}`,
    label: `${server.name} · ${server.username}@${server.host}`,
  };
  return (
    'termius://app/host-sharing#' +
    Object.entries(values)
      .map(([k, v]) => `${k}=${encodeURIComponent(encodeURIComponent(encodeURIComponent(v)))}`)
      .join('&')
  );
}
export async function createBridge({
  port,
  host = '127.0.0.1',
  publicHost = '127.0.0.1',
  publicPort,
  dataDir,
  vaultKey,
  onStatus = async () => {},
  record,
  authorize = async () => true,
  maxClients = 200,
  maxPerIp = 12,
}) {
  if (!Buffer.isBuffer(vaultKey) || vaultKey.length !== 32)
    throw new Error('SSH 网关主机密钥必须加密保存');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = `${dataDir}/bridge-host-key.enc`;
  let key;
  try {
    key = decrypt(await readFile(file, 'utf8'), vaultKey, 'ssh-gateway-host-key:v1').privateKey;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try {
      await readFile(`${dataDir}/bridge-host-key.pem`);
      throw new Error('检测到旧网关私钥，请先运行 npm run secrets:migrate，保留原主机指纹');
    } catch (legacy) {
      if (legacy.code !== 'ENOENT') throw legacy;
    }
    key = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey;
    await writeFile(file, encrypt({ privateKey: key }, vaultKey, 'ssh-gateway-host-key:v1'), {
      mode: 0o600,
      flag: 'wx',
    });
  }
  const tickets = new Map(),
    clients = new Map(),
    byIp = new Map(),
    finalizers = new Set();
  const status = (ticket, state, message = '') =>
    onStatus(ticket.id, ticket.serverId, state, message, ticket.meta).catch(() => {});
  const server = new ssh2.Server(
    { hostKeys: [key], algorithms: sshAlgorithms, ident: 'ServerHarbor', readyTimeout: 15000 },
    (client, info) => {
      const ip = info.ip;
      if (clients.size >= maxClients || (byIp.get(ip) || 0) >= maxPerIp) {
        client.on('error', () => {});
        client.end();
        return;
      }
      byIp.set(ip, (byIp.get(ip) || 0) + 1);
      clients.set(client, null);
      let ticket,
        recorder,
        recorderPromise,
        finalizing,
        closed = false,
        expiryTimer;
      const finish = () => {
        if (finalizing) return finalizing;
        finalizing = (async () => {
          await recorderPromise;
          await recorder?.close();
          if (ticket) await status(ticket, 'closed');
        })().catch(() => {});
        finalizers.add(finalizing);
        finalizing.finally(() => finalizers.delete(finalizing));
        return finalizing;
      };
      client.on('error', () => {});
      client.on('authentication', (ctx) => {
        if (closed || ticket) return ctx.reject();
        const token = ctx.username.split('--').at(-1),
          candidate = tickets.get(token);
        if (!candidate || candidate.expires < Date.now() || ctx.username !== candidate.username)
          return ctx.reject();
        // Consume synchronously before awaiting the current account permissions.
        tickets.delete(token);
        clearTimeout(candidate.timer);
        Promise.resolve(authorize(candidate.meta))
          .then((allowed) => {
            if (!allowed || closed) {
              candidate.remote.end();
              status(candidate, 'failed', '账号权限已撤销');
              return ctx.reject();
            }
            ticket = candidate;
            clients.set(client, ticket);
            ctx.accept();
          })
          .catch(() => {
            candidate.remote.end();
            ctx.reject();
          });
      });
      client.on('ready', () => {
        if (!ticket) return client.end();
        if (Number.isFinite(ticket.meta.expiresAt)) {
          const remaining = ticket.meta.expiresAt - Date.now();
          if (remaining <= 0) return client.end();
          expiryTimer = setTimeout(
            () => {
              ticket.remote.end();
              client.end();
            },
            Math.min(remaining, 2147483647),
          );
          expiryTimer.unref();
        }
        status(ticket, 'connected');
        client.on('session', (accept) => {
          const session = accept();
          let pty = { term: 'xterm-256color', cols: 100, rows: 30 },
            stream;
          session.on('pty', (yes, no, info) => {
            pty = {
              term: info.term,
              cols: info.cols,
              rows: info.rows,
              width: info.width,
              height: info.height,
            };
            yes();
          });
          session.on('window-change', (yes, no, info) => {
            stream?.setWindow(info.rows, info.cols, info.height, info.width);
            yes?.();
          });
          session.on('shell', async (yes, no) => {
            if (ticket.used) return no();
            ticket.used = true;
            try {
              recorderPromise = record
                ? record(ticket, () => {
                    status(ticket, 'failed', '会话录制失败或达到容量限制，连接已停止');
                    client.end();
                    ticket.remote.end();
                  })
                : Promise.resolve(null);
              recorder = await recorderPromise;
            } catch {
              status(ticket, 'failed', '无法开启会话录制，连接已停止');
              no();
              client.end();
              ticket.remote.end();
              return;
            }
            if (closed) {
              await recorder?.close();
              return;
            }
            ticket.remote.shell(pty, (error, channel) => {
              if (error) {
                status(ticket, 'failed', '无法启动远程 Shell');
                no();
                client.end();
                return;
              }
              stream = channel;
              const local = yes();
              local.on('data', (chunk) => recorder?.write('input', chunk, local));
              channel.on('data', (chunk) => recorder?.write('output', chunk, channel));
              channel.stderr.on('data', (chunk) =>
                recorder?.write('stderr', chunk, channel.stderr),
              );
              local.pipe(channel).pipe(local);
              channel.stderr.pipe(local.stderr);
              channel.on('error', () => client.end());
              local.on('error', () => channel.close());
              channel.on('exit', (code, signal) => {
                if (Number.isInteger(code)) local.exit(code);
                else if (signal) local.exit(signal);
              });
              channel.on('close', () => {
                local.end();
                client.end();
              });
              local.on('close', () => channel.close());
            });
          });
        });
      });
      client.on('close', () => {
        closed = true;
        clearTimeout(expiryTimer);
        clients.delete(client);
        const n = (byIp.get(ip) || 1) - 1;
        if (n) byIp.set(ip, n);
        else byIp.delete(ip);
        if (ticket) ticket.remote.end();
        finish();
      });
    },
  );
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  server.on('error', () => {});
  const revoke = async (predicate) => {
    for (const [token, t] of tickets) {
      if (predicate(t)) {
        tickets.delete(token);
        clearTimeout(t.timer);
        t.remote.end();
        await status(t, 'failed', '连接权限已撤销');
      }
    }
    for (const [client, t] of clients)
      if (t && predicate(t)) {
        t.remote.end();
        client.end();
      }
  };
  return {
    port: server.address().port,
    fingerprint: () => fingerprint(ssh2.utils.parseKey(key).getPublicSSH()),
    async launch(remote, row, id, meta = {}) {
      if (tickets.size + clients.size >= maxClients)
        throw new Error('Gateway session limit reached');
      const token = randomBytes(24).toString('hex'),
        ticket = {
          remote,
          id,
          serverId: row.id,
          server: row,
          meta: typeof meta === 'object' ? meta : {},
          username: `${row.username}--${token}`,
          expires: Date.now() + 90000,
        };
      ticket.timer = setTimeout(() => {
        tickets.delete(token);
        remote.end();
        status(ticket, 'failed', 'Termius 未在 90 秒内接入，请重试');
      }, 90000);
      ticket.timer.unref();
      tickets.set(token, ticket);
      remote.once('close', () => {
        if (tickets.has(token)) {
          clearTimeout(ticket.timer);
          tickets.delete(token);
          status(ticket, 'failed', '远程连接在终端接入前关闭');
        }
      });
      return {
        url: termiusLink(row, publicPort || server.address().port, token, publicHost),
        username: ticket.username,
        expiresIn: 90,
      };
    },
    activeCount: (id) =>
      [...tickets.values(), ...clients.values()].filter((t) => t?.meta.user?.id === id).length,
    revokeUser: (id) => revoke((t) => t.meta.user?.id === id),
    revokeServer: (id) => revoke((t) => t.serverId === id),
    async close() {
      for (const t of tickets.values()) {
        clearTimeout(t.timer);
        t.remote.end();
      }
      tickets.clear();
      for (const [client] of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...finalizers]);
    },
  };
}
