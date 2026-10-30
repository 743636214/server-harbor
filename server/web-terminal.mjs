import { WebSocketServer } from 'ws';
import ssh2 from 'ssh2';
import { createHash } from 'node:crypto';
import { sshAlgorithms } from './ssh.mjs';
export function attachWebTerminals({ http, app, bridge }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  http.on('upgrade', async (req, socket, head) => {
    try {
      if (wss.clients.size >= 200) {
        socket.destroy();
        return;
      }
      if (
        new URL(req.url, 'http://localhost').pathname !== '/terminal' ||
        !app.harborSocketOrigin(req)
      ) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const user = await app.harborAuthenticate(req);
      if (!user || !user.permissions['server.connect']) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, user));
    } catch {
      socket.destroy();
    }
  });
  wss.on('connection', (ws, user) => {
    let client,
      channel,
      opened = false;
    const timeout = setTimeout(() => ws.close(1008, '连接令牌超时'), 10000);
    const send = (type, data = {}) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...data }));
    };
    ws.on('message', async (data, binary) => {
      try {
        if (binary) {
          if (channel) channel.write(data);
          return;
        }
        const message = JSON.parse(data.toString());
        if (message.type === 'open' && !opened) {
          opened = true;
          clearTimeout(timeout);
          const ticket = await app.harborTakeWebTicket(message.token, user);
          if (!ticket) {
            send('error', { message: '网页终端令牌无效或已过期' });
            ws.close();
            return;
          }
          client = new ssh2.Client();
          client.on('error', () => {
            send('error', { message: 'SSH 网关连接已关闭或权限已撤销' });
            ws.close();
          });
          client.on('close', () => {
            send('closed');
            ws.close();
          });
          client.on('ready', () =>
            client.shell(
              {
                term: 'xterm-256color',
                cols: Math.max(20, Math.min(400, Number(message.cols) || 100)),
                rows: Math.max(5, Math.min(150, Number(message.rows) || 30)),
              },
              (error, stream) => {
                if (error) {
                  send('error', { message: '无法创建远程终端' });
                  client.end();
                  return;
                }
                channel = stream;
                stream.on('data', (chunk) => {
                  if (ws.readyState === 1) {
                    if (ws.bufferedAmount > 2097152) {
                      stream.pause();
                      const timer = setInterval(() => {
                        if (ws.readyState !== 1) {
                          clearInterval(timer);
                          return;
                        }
                        if (ws.bufferedAmount < 262144) {
                          clearInterval(timer);
                          stream.resume();
                        }
                      }, 50);
                      timer.unref();
                    }
                    ws.send(chunk, { binary: true });
                  }
                });
                stream.stderr.on('data', (chunk) => {
                  if (ws.readyState === 1) ws.send(chunk, { binary: true });
                });
                stream.on('error', () => client.end());
                stream.on('close', () => client.end());
                send('ready');
              },
            ),
          );
          client.connect({
            host: '127.0.0.1',
            port: bridge.port,
            username: ticket.username,
            algorithms: sshAlgorithms,
            readyTimeout: 10000,
            hostVerifier: (key) =>
              bridge.fingerprint() ===
              'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, ''),
          });
        } else if (message.type === 'resize' && channel) {
          channel.setWindow(
            Math.max(5, Math.min(150, Number(message.rows) || 30)),
            Math.max(20, Math.min(400, Number(message.cols) || 100)),
            0,
            0,
          );
        }
      } catch {
        send('error', { message: '终端请求无效' });
        ws.close(1008);
      }
    });
    ws.on('close', () => {
      clearTimeout(timeout);
      channel?.close();
      client?.end();
    });
    ws.on('error', () => client?.end());
  });
  return {
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
