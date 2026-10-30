import express from 'express';
import helmet from 'helmet';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import ssh2 from 'ssh2';
import { encrypt, decrypt, hashPassword, verifyPassword } from './crypto.mjs';
import { serverSchema, passwordSchema, usernameSchema, userSchema } from './validation.mjs';
import { publicColumns, publicServer } from './db.mjs';
import { inspectFingerprint, connectRemote } from './ssh.mjs';
import { permissionsFor, publicUser, transaction } from './permissions.mjs';
import { writeAudit, changes } from './audit.mjs';
import { readRecording } from './recordings.mjs';
import { readMetrics } from './monitor.mjs';
import { mountCloudRoutes } from './cloud/routes.mjs';
import { createLimiter } from './rate-limit.mjs';
import { guardedLogin } from './login-security.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const parseJSON = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const defaultConfig = {
  production: false,
  publicUrl: 'http://127.0.0.1:4317',
  allowedOrigins: [],
  proxy: false,
  secureCookie: false,
  bootstrapToken: '',
  gatewayHost: '127.0.0.1',
  gatewayPort: 4320,
  recording: true,
};
export function createApp({ db, key, bridge, rootDir, config: options = {}, recordingDir }) {
  const config = { ...defaultConfig, ...options },
    app = express(),
    attempts = createLimiter(),
    connecting = new Map(),
    webTickets = new Map(),
    trustTickets = new Map();
  const cookieName = config.secureCookie ? '__Host-harbor_session' : 'harbor_session';
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of trustTickets) if (v.expires < now) trustTickets.delete(k);
    for (const [k, v] of webTickets) if (v.expires < now) webTickets.delete(k);
    db.execute('DELETE FROM sessions WHERE expires_at<UTC_TIMESTAMP()').catch(() => {});
    db.execute(
      'DELETE FROM login_attempts WHERE updated_at<DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) AND (locked_until IS NULL OR locked_until<=UTC_TIMESTAMP())',
    ).catch(() => {});
  }, 60000);
  cleanup.unref();
  app.disable('x-powered-by');
  if (config.proxy) app.set('trust proxy', config.proxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          upgradeInsecureRequests: config.production ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.production ? { maxAge: 31536000 } : false,
    }),
  );
  const allowedHost = (value) =>
    config.production
      ? value === new URL(config.publicUrl).host
      : /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(value || '');
  const localPeer = (req) =>
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const allowedOrigin = (origin, host) =>
    config.production
      ? origin === config.publicUrl
      : origin === 'http://' + host || config.allowedOrigins.includes(origin);
  app.use((req, res, next) => {
    if (!config.production && !localPeer(req))
      return res.status(403).json({ error: '本地模式拒绝远程访问' });
    if (!allowedHost(req.get('host'))) return res.status(403).json({ error: '访问域名未获允许' });
    if (config.production && !req.secure)
      return res.status(403).json({ error: '公网访问必须通过 HTTPS' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      let valid = true;
      try {
        const origin = req.get('origin');
        if (origin) {
          valid = allowedOrigin(origin, req.get('host'));
        } else valid = !config.production;
      } catch {
        valid = false;
      }
      if (
        !valid ||
        req.get('sec-fetch-site') === 'cross-site' ||
        req.get('x-server-harbor') !== '1' ||
        !req.is('application/json')
      )
        return res.status(403).json({ error: '请求来源验证失败' });
    }
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const token = (req) =>
    ((req.get ? req.get('cookie') : req.headers.cookie) || '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + '='))
      ?.slice(cookieName.length + 1);
  const audit = (req, action, server = null, details = {}, outcome = 'success', store = db) =>
    writeAudit(store, { user: req.user, server, action, outcome, ip: req.ip, details });
  const getRow = async (id) => {
    const [rows] = await db.execute('SELECT * FROM servers WHERE id=?', [id]);
    if (!rows[0]) throw Object.assign(new Error('服务器不存在'), { status: 404 });
    return rows[0];
  };
  const session = async (req, res, store = db, user = req.user) => {
    const previous = token(req);
    if (previous)
      await store.execute('DELETE FROM sessions WHERE token_hash=?', [digest(previous)]);
    const raw = randomBytes(32).toString('hex');
    await store.execute('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)', [
      digest(raw),
      user.id,
      new Date(Date.now() + 8 * 3600000),
    ]);
    res.cookie(cookieName, raw, {
      httpOnly: true,
      secure: config.secureCookie,
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 3600000,
    });
  };
  const authenticate = async (req) => {
    const raw = token(req);
    if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return null;
    const [rows] = await db.execute(
      'SELECT u.*,s.expires_at AS session_expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() AND u.active=TRUE',
      [digest(raw)],
    );
    if (!rows[0]) return null;
    req.sessionHash = digest(raw);
    req.sessionExpiresAt = new Date(rows[0].session_expires_at).getTime();
    return publicUser(rows[0]);
  };
  app.harborAuthenticate = authenticate;
  app.harborSocketOrigin = (req) => {
    if (!allowedHost(req.headers.host) || (!config.production && !localPeer(req))) return false;
    const origin = req.headers.origin;
    if (!origin || !allowedOrigin(origin, req.headers.host)) return false;
    if (!config.production) return true;
    const trust = app.get('trust proxy fn');
    return Boolean(
      req.socket.encrypted ||
      (trust?.(req.socket.remoteAddress, 0) && req.headers['x-forwarded-proto'] === 'https'),
    );
  };
  app.harborTakeWebTicket = async (value, user) => {
    const ticket = webTickets.get(value);
    if (!ticket || ticket.userId !== user.id || ticket.expires < Date.now()) return null;
    webTickets.delete(value);
    return ticket;
  };
  app.use('/api', async (req, res, next) => {
    req.user = await authenticate(req);
    next();
  });
  app.get('/api/health', async (req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true });
  });
  app.get('/api/auth/status', async (req, res) => {
    const [[count]] = await db.query('SELECT COUNT(*) AS total FROM users');
    res.json({
      initialized: count.total > 0,
      authenticated: Boolean(req.user),
      user: req.user || null,
      setupTokenRequired: config.production,
    });
  });
  app.post('/api/auth/setup', async (req, res) => {
    if (!attempts.take('setup:' + req.ip, 8))
      return res.status(429).json({ error: '初始化请求过于频繁' });
    if (
      config.production &&
      (config.bootstrapToken.length < 32 || !equal(req.body.setup_token, config.bootstrapToken))
    )
      return res.status(403).json({ error: '首次初始化需要部署者持有的初始化令牌' });
    const { password } = passwordSchema.parse(req.body),
      username = usernameSchema.parse(req.body.username || 'admin'),
      display_name =
        String(req.body.display_name || '管理员')
          .trim()
          .slice(0, 100) || '管理员';
    const password_hash = await hashPassword(password);
    await transaction(db, async (store) => {
      await store.execute("INSERT IGNORE INTO settings(name,value) VALUES ('bootstrap_guard','1')");
      await store.query("SELECT value FROM settings WHERE name='bootstrap_guard' FOR UPDATE");
      const [[count]] = await store.query('SELECT COUNT(*) AS total FROM users');
      if (count.total) throw Object.assign(new Error('管理员已初始化，请登录'), { status: 409 });
      const id = randomUUID();
      await store.execute(
        "INSERT INTO users(id,username,display_name,password_hash,role,permissions) VALUES (?,?,?,?,'admin',JSON_OBJECT())",
        [id, username, display_name, password_hash],
      );
      req.user = publicUser({
        id,
        username,
        display_name,
        role: 'admin',
        permissions: {},
        active: true,
      });
      await session(req, res, store);
      await audit(req, 'account.bootstrap', null, {}, 'success', store);
    });
    res.json({ ok: true, user: req.user });
  });
  app.post('/api/auth/login', async (req, res) => {
    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const name = String(body.username || 'admin')
      .trim()
      .toLowerCase()
      .slice(0, 64);
    if (!attempts.take('ip:' + req.ip, 40))
      return res.status(429).json({ error: '尝试过于频繁，请 5 分钟后重试' });
    const [[row]] = await db.execute('SELECT * FROM users WHERE username=?', [name]);
    // Existing accounts use their immutable ID, including collation aliases and renames.
    // Unknown accounts follow the same response policy without storing raw names.
    const accountKey = digest(row ? 'user:' + row.id : 'unknown:' + name);
    const account = row?.username || name;
    const outcome = await guardedLogin(db, {
      accountKey,
      check: async (store) => {
        const [[current]] = row
          ? await store.execute('SELECT * FROM users WHERE id=? AND username=? FOR UPDATE', [
              row.id,
              name,
            ])
          : [[]];
        const valid = typeof body.password === 'string' && body.password.length <= 128;
        const matches = await verifyPassword(
          valid ? body.password : '',
          current?.password_hash || `scrypt$32768$8$3$${'0'.repeat(32)}$${'0'.repeat(128)}`,
        );
        return valid && current?.active && matches ? current : null;
      },
      onSuccess: async (store, current) => {
        req.user = publicUser(current);
        if (!current.password_hash.startsWith('scrypt$32768$8$3$'))
          await store.execute('UPDATE users SET password_hash=? WHERE id=?', [
            await hashPassword(body.password),
            current.id,
          ]);
        await session(req, res, store);
        await audit(req, 'account.login', null, {}, 'success', store);
        return req.user;
      },
      onFailure: (store, failures) =>
        audit(req, 'account.login', null, { account, failedAttempts: failures }, 'failed', store),
      onLock: async (store, lockedUntil) => {
        if (row) await store.execute('DELETE FROM sessions WHERE user_id=?', [row.id]);
        await audit(
          req,
          'account.login.lock',
          null,
          {
            account,
            lockedUntil: lockedUntil.toISOString(),
            timezone: 'Asia/Shanghai',
            failedAttempts: 5,
          },
          'denied',
          store,
        );
      },
      onUnlock: (store) =>
        audit(
          req,
          'account.login.unlock',
          null,
          { account, reason: 'next_beijing_day' },
          'success',
          store,
        ),
    });
    if (outcome.kind === 'success') return res.json({ ok: true, user: outcome.user });
    if (outcome.kind === 'failure')
      return res.status(401).json({
        error: `账号或密码不正确，或账号已停用；还可尝试 ${outcome.remaining} 次`,
        remaining_attempts: outcome.remaining,
      });
    if (outcome.newlyLocked && row) {
      await bridge.revokeUser?.(row.id);
      for (const [ticket, value] of webTickets)
        if (value.userId === row.id) webTickets.delete(ticket);
      for (const [ticket, value] of trustTickets)
        if (value.userId === row.id) trustTickets.delete(ticket);
    }
    const date = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(outcome.lockedUntil);
    res.set(
      'Retry-After',
      String(Math.max(1, Math.ceil((outcome.lockedUntil - outcome.now) / 1000))),
    );
    res.status(429).json({
      error: `账号已因连续 5 次登录失败被锁定，将于北京时间 ${date} 00:00 自动解封；也可联系管理员提前解锁`,
      code: 'ACCOUNT_LOCKED',
      locked_until: outcome.lockedUntil.toISOString(),
    });
  });
  app.use('/api', (req, res, next) =>
    req.user ? next() : res.status(401).json({ error: '请先登录' }),
  );
  const requirePermission = (permission) => async (req, res, next) => {
    if (permissionsFor(req.user)[permission]) return next();
    let server;
    if (req.params.id) {
      const [rows] = await db.execute('SELECT id,name FROM servers WHERE id=?', [req.params.id]);
      server = rows[0];
    }
    await audit(req, 'permission.denied', server, { permission, method: req.method }, 'denied');
    res.status(403).json({ error: '没有此操作权限，请联系管理员授权' });
  };
  const requireAdmin = async (req, res, next) => {
    if (req.user.role === 'admin') return next();
    await audit(req, 'permission.denied', null, { permission: 'account.admin' }, 'denied');
    res.status(403).json({ error: '此操作仅限管理员' });
  };
  app.post('/api/auth/logout', async (req, res) => {
    await transaction(db, async (store) => {
      await store.execute('DELETE FROM sessions WHERE token_hash=?', [digest(token(req) || '')]);
      await audit(req, 'account.logout', null, {}, 'success', store);
    });
    await bridge.revokeUser?.(req.user.id);
    for (const [ticket, value] of webTickets)
      if (value.userId === req.user.id) webTickets.delete(ticket);
    for (const [ticket, value] of trustTickets)
      if (value.userId === req.user.id) trustTickets.delete(ticket);
    res.clearCookie(cookieName, {
      secure: config.secureCookie,
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
    });
    res.json({ ok: true });
  });
  app.post('/api/auth/password', async (req, res) => {
    if (!attempts.take('password:' + req.user.id, 8))
      return res.status(429).json({ error: '修改密码请求过于频繁，请稍后重试' });
    const { password } = passwordSchema.parse(req.body);
    const [[user]] = await db.execute('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
    if (
      typeof req.body.current_password !== 'string' ||
      !(await verifyPassword(req.body.current_password, user.password_hash))
    )
      return res.status(400).json({ error: '当前密码不正确' });
    const hash = await hashPassword(password);
    await transaction(db, async (store) => {
      await store.execute('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id]);
      await store.execute('DELETE FROM sessions WHERE user_id=?', [req.user.id]);
      await session(req, res, store);
      await audit(req, 'account.password.change', null, {}, 'success', store);
    });
    await bridge.revokeUser?.(req.user.id);
    res.json({ ok: true });
  });
  app.get('/api/users', requireAdmin, async (req, res) => {
    const [rows] = await db.query(
      "SELECT u.*,CASE WHEN a.locked_until>UTC_TIMESTAMP(3) THEN a.locked_until ELSE NULL END AS login_locked_until FROM users u LEFT JOIN login_attempts a ON a.account_hash=SHA2(CONCAT('user:',u.id),256) ORDER BY u.created_at,u.username",
    );
    res.json(rows.map(publicUser));
  });
  app.post('/api/users/:id/unlock', requireAdmin, async (req, res) => {
    const [[account]] = await db.execute('SELECT id FROM users WHERE id=?', [req.params.id]);
    if (!account) throw Object.assign(new Error('账号不存在'), { status: 404 });
    const accountKey = digest('user:' + account.id);
    let manuallyDisabled = false;
    await transaction(db, async (store) => {
      await store.execute(
        'INSERT INTO login_attempts(account_hash) VALUES (?) ON DUPLICATE KEY UPDATE account_hash=account_hash',
        [accountKey],
      );
      const [[state]] = await store.execute(
        'SELECT failed_count,locked_until FROM login_attempts WHERE account_hash=? FOR UPDATE',
        [accountKey],
      );
      const [[actor]] = await store.execute(
        "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() AND u.active=TRUE AND u.role='admin' FOR UPDATE",
        [req.user.id, req.sessionHash],
      );
      if (!actor) throw Object.assign(new Error('管理员登录已失效，请重新登录'), { status: 403 });
      const [[target]] = await store.execute('SELECT id,username,active FROM users WHERE id=?', [
        account.id,
      ]);
      if (!target) throw Object.assign(new Error('账号不存在'), { status: 404 });
      manuallyDisabled = !target.active;
      await store.execute(
        'UPDATE login_attempts SET failed_count=0,attempt_day=DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR),locked_until=NULL,updated_at=UTC_TIMESTAMP(3) WHERE account_hash=?',
        [accountKey],
      );
      await audit(
        req,
        'account.login.admin_unlock',
        null,
        {
          account: target.username,
          targetUserId: target.id,
          previousFailures: state.failed_count,
          previousLockedUntil: state.locked_until,
          manuallyDisabled,
        },
        'success',
        store,
      );
    });
    res.json({
      ok: true,
      message: manuallyDisabled
        ? '登录锁定已解除；账号仍为手动停用状态，需要另行启用'
        : '登录锁定已解除，失败次数已清零，请重新登录',
    });
  });
  app.post('/api/users', requireAdmin, async (req, res) => {
    const data = userSchema.parse(req.body);
    if (!data.password) return res.status(400).json({ error: '新账号需要设置初始密码' });
    const hash = await hashPassword(data.password),
      id = randomUUID();
    await transaction(db, async (store) => {
      await store.execute(
        'INSERT INTO users(id,username,display_name,password_hash,role,permissions,active) VALUES (?,?,?,?,?,?,?)',
        [
          id,
          data.username,
          data.display_name,
          hash,
          data.role,
          JSON.stringify(data.permissions),
          data.active,
        ],
      );
      await audit(
        req,
        'account.create',
        null,
        { account: data.username, role: data.role, permissions: data.permissions },
        'success',
        store,
      );
    });
    res.status(201).json({ ok: true, id });
  });
  app.put('/api/users/:id', requireAdmin, async (req, res) => {
    const data = userSchema.parse(req.body),
      hash = data.password ? await hashPassword(data.password) : null;
    await transaction(db, async (store) => {
      const [admins] = await store.query(
        "SELECT id FROM users WHERE role='admin' AND active=TRUE FOR UPDATE",
      );
      const [[previous]] = await store.execute('SELECT * FROM users WHERE id=? FOR UPDATE', [
        req.params.id,
      ]);
      if (!previous) throw Object.assign(new Error('账号不存在'), { status: 404 });
      if (
        previous.role === 'admin' &&
        previous.active &&
        (!data.active || data.role !== 'admin') &&
        admins.length < 2
      )
        throw Object.assign(new Error('至少保留一名可用管理员'), { status: 400 });
      if (previous.id === req.user.id && (!data.active || data.role !== 'admin'))
        throw Object.assign(new Error('不能停用或降级当前登录的管理员账号'), { status: 400 });
      await store.execute(
        'UPDATE users SET username=?,display_name=?,role=?,permissions=?,active=?,password_hash=? WHERE id=?',
        [
          data.username,
          data.display_name,
          data.role,
          JSON.stringify(data.permissions),
          data.active,
          hash || previous.password_hash,
          req.params.id,
        ],
      );
      await store.execute('DELETE FROM sessions WHERE user_id=?', [req.params.id]);
      await audit(
        req,
        'account.update',
        null,
        {
          account: previous.username,
          updatedAccount: data.username,
          role: { from: previous.role, to: data.role },
          permissions: { from: parseJSON(previous.permissions), to: data.permissions },
          active: data.active,
          passwordReset: Boolean(hash),
        },
        'success',
        store,
      );
    });
    await bridge.revokeUser?.(req.params.id);
    res.json({ ok: true });
  });
  const listColumns = publicColumns
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== 'favorite')
    .map((v) => 's.' + v)
    .join(',');

  app.get('/api/servers', async (req, res) => {
    const [rows] = await db.execute(
      `SELECT ${listColumns},(f.server_id IS NOT NULL) AS favorite FROM servers s LEFT JOIN user_favorites f ON f.server_id=s.id AND f.user_id=? ORDER BY favorite DESC,s.name ASC`,
      [req.user.id],
    );
    res.json(rows.map(publicServer));
  });
  async function save(req, res) {
    const data = serverSchema.parse(req.body),
      previous = req.params.id ? await getRow(req.params.id) : null,
      id = previous?.id || randomUUID();
    const old =
      previous &&
      previous.auth_type === data.auth_type &&
      previous.host === data.host &&
      previous.port === data.port &&
      previous.username === data.username
        ? decrypt(previous.credentials, key, id)
        : {};
    const credentials =
      data.auth_type === 'password'
        ? { password: data.password || old.password }
        : {
            privateKey: data.privateKey?.trim() || old.privateKey,
            passphrase: data.clearPassphrase ? '' : data.passphrase || old.passphrase || '',
          };
    if (data.auth_type === 'password' && !credentials.password)
      return res.status(400).json({ error: '请输入 SSH 密码' });
    if (data.auth_type === 'key') {
      if (!credentials.privateKey) return res.status(400).json({ error: '请输入 SSH 私钥' });
      const parsed = ssh2.utils.parseKey(
        credentials.privateKey,
        credentials.passphrase || undefined,
      );
      if (parsed instanceof Error || !parsed?.isPrivateKey?.())
        return res.status(400).json({ error: '私钥格式或私钥口令不正确' });
    }
    const fields = [
      data.name,
      data.host,
      data.port,
      data.username,
      data.auth_type,
      data.environment,
      data.group_name,
      JSON.stringify(data.tags),
      data.notes,
      encrypt(credentials, key, id),
    ];
    await transaction(db, async (store) => {
      if (previous)
        await store.execute(
          'UPDATE servers SET name=?,host=?,port=?,username=?,auth_type=?,environment=?,group_name=?,tags=?,notes=?,credentials=?,fingerprint=? WHERE id=?',
          [
            ...fields,
            previous.host === data.host && previous.port === data.port
              ? previous.fingerprint
              : null,
            id,
          ],
        );
      else
        await store.execute(
          'INSERT INTO servers(name,host,port,username,auth_type,environment,group_name,tags,notes,credentials,id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [...fields, id],
        );
      if (data.favorite)
        await store.execute('INSERT IGNORE INTO user_favorites(user_id,server_id) VALUES (?,?)', [
          req.user.id,
          id,
        ]);
      else
        await store.execute('DELETE FROM user_favorites WHERE user_id=? AND server_id=?', [
          req.user.id,
          id,
        ]);
      await audit(
        req,
        previous ? 'server.update' : 'server.create',
        { id, name: data.name },
        { changes: changes(previous, data) },
        'success',
        store,
      );
    });
    if (previous) await bridge.revokeServer?.(id);
    const row = await getRow(id);
    delete row.credentials;
    res.status(previous ? 200 : 201).json(publicServer({ ...row, favorite: data.favorite }));
  }
  app.post('/api/servers', requirePermission('server.create'), save);
  app.put('/api/servers/:id', requirePermission('server.edit'), save);
  app.patch('/api/servers/:id/favorite', async (req, res) => {
    const row = await getRow(req.params.id);
    if (typeof req.body.favorite !== 'boolean')
      return res.status(400).json({ error: '收藏参数不正确' });
    await transaction(db, async (store) => {
      if (req.body.favorite)
        await store.execute('INSERT IGNORE INTO user_favorites(user_id,server_id) VALUES (?,?)', [
          req.user.id,
          row.id,
        ]);
      else
        await store.execute('DELETE FROM user_favorites WHERE user_id=? AND server_id=?', [
          req.user.id,
          row.id,
        ]);
      await audit(req, 'server.favorite', row, { favorite: req.body.favorite }, 'success', store);
    });
    res.json({ ok: true });
  });
  app.delete('/api/servers/:id', requirePermission('server.delete'), async (req, res) => {
    const row = await getRow(req.params.id);
    await transaction(db, async (store) => {
      await audit(req, 'server.delete', row, {}, 'success', store);
      await store.execute('DELETE FROM servers WHERE id=?', [row.id]);
    });
    await bridge.revokeServer?.(row.id);
    res.json({ ok: true });
  });
  app.post('/api/servers/:id/fingerprint', requirePermission('server.edit'), async (req, res) => {
    const row = await getRow(req.params.id);
    try {
      const observed = await inspectFingerprint(row),
        ticket = randomBytes(24).toString('hex');
      trustTickets.set(ticket, {
        id: row.id,
        userId: req.user.id,
        host: row.host,
        port: row.port,
        fingerprint: observed,
        expires: Date.now() + 120000,
      });
      await audit(req, 'server.fingerprint.inspect', row);
      res.json({
        fingerprint: observed,
        previous: row.fingerprint,
        changed: Boolean(row.fingerprint && row.fingerprint !== observed),
        ticket,
      });
    } catch (error) {
      await audit(req, 'server.fingerprint.inspect', row, {}, 'failed');
      throw error;
    }
  });
  app.post('/api/servers/:id/trust', requirePermission('server.edit'), async (req, res) => {
    const row = await getRow(req.params.id),
      ticket = trustTickets.get(req.body.ticket);
    trustTickets.delete(req.body.ticket);
    if (
      !ticket ||
      ticket.userId !== req.user.id ||
      ticket.id !== row.id ||
      ticket.host !== row.host ||
      ticket.port !== row.port ||
      ticket.expires < Date.now()
    )
      return res.status(400).json({ error: '指纹确认已失效，请重试' });
    await transaction(db, async (store) => {
      const [[current]] = await store.execute('SELECT * FROM servers WHERE id=? FOR UPDATE', [
        row.id,
      ]);
      if (
        !current ||
        current.host !== ticket.host ||
        current.port !== ticket.port ||
        current.fingerprint !== row.fingerprint
      )
        throw Object.assign(new Error('服务器配置或指纹已更新，请重新核实'), { status: 409 });
      await store.execute('UPDATE servers SET fingerprint=? WHERE id=?', [
        ticket.fingerprint,
        row.id,
      ]);
      await audit(
        req,
        'server.fingerprint.trust',
        row,
        { previous: row.fingerprint, current: ticket.fingerprint },
        'success',
        store,
      );
    });
    res.json({ ok: true });
  });
  app.post('/api/servers/:id/connect', requirePermission('server.connect'), async (req, res) => {
    const row = await getRow(req.params.id);
    if (!row.fingerprint) {
      await audit(req, 'ssh.connect', row, { reason: 'host_key_required' }, 'denied');
      return res.status(409).json({
        error: '首次连接需要管理员或获授权的成员核对并信任主机指纹',
        code: 'HOST_KEY_REQUIRED',
      });
    }
    const inFlight = connecting.get(req.user.id) || 0;
    if (inFlight + (bridge.activeCount?.(req.user.id) || 0) >= 5) {
      await audit(req, 'ssh.connect', row, { reason: 'session_limit' }, 'denied');
      return res.status(429).json({ error: '每个账号最多同时准备或保持 5 个 SSH 连接' });
    }
    connecting.set(req.user.id, inFlight + 1);
    try {
      const id = randomUUID();
      await transaction(db, async (store) => {
        await store.execute(
          "INSERT INTO connections(id,server_id,server_name,status) VALUES (?,?,?,'launching')",
          [id, row.id, row.name],
        );
        await store.execute(
          'INSERT INTO connection_actors(connection_id,user_id,username,ip) VALUES (?,?,?,?)',
          [id, req.user.id, req.user.username, req.ip],
        );
        await audit(
          req,
          'ssh.request',
          row,
          { connectionId: id, client: req.body.client === 'web' ? 'web' : 'termius' },
          'success',
          store,
        );
      });
      let remote;
      try {
        remote = await connectRemote(row, decrypt(row.credentials, key, row.id));
        const [[current]] = await db.execute('SELECT * FROM users WHERE id=?', [req.user.id]);
        if (!current?.active || !permissionsFor(current)['server.connect'])
          throw new Error('Permission revoked');
        const latest = await getRow(row.id);
        if (
          latest.host !== row.host ||
          latest.port !== row.port ||
          latest.username !== row.username ||
          latest.fingerprint !== row.fingerprint ||
          latest.credentials !== row.credentials
        )
          throw new Error('Server configuration changed');
        const launch = await bridge.launch(remote, row, id, {
          user: req.user,
          ip: req.ip,
          sessionHash: req.sessionHash,
          expiresAt: req.sessionExpiresAt,
        });
        if (req.body.client === 'web') {
          const webToken = randomBytes(32).toString('hex');
          webTickets.set(webToken, {
            userId: req.user.id,
            username: launch.username,
            expires: Date.now() + 90000,
            connectionId: id,
          });
          return res.json({ ok: true, id, webToken, expiresIn: 90, recording: config.recording });
        }
        res.json({
          ok: true,
          id,
          url: launch.url,
          gatewayFingerprint: bridge.fingerprint?.(),
          expiresIn: launch.expiresIn,
          recording: config.recording,
          message: '请在你自己的电脑上打开 Termius',
        });
      } catch (error) {
        remote?.end();
        const changed = error.code === 'HOST_KEY_CHANGED';
        await transaction(db, async (store) => {
          await store.execute("UPDATE connections SET status='failed',message=? WHERE id=?", [
            changed ? 'SSH 主机指纹已变化' : '连接失败，请检查网络或 SSH 凭据',
            id,
          ]);
          await audit(
            req,
            'ssh.connect',
            row,
            { connectionId: id, reason: changed ? 'host_key_changed' : 'connection_failed' },
            'failed',
            store,
          );
        });
        res.status(changed ? 409 : 502).json({
          error: changed
            ? 'SSH 主机指纹已变化，请联系获授权成员重新核实'
            : error.level === 'client-authentication'
              ? 'SSH 账号或凭据验证失败'
              : '无法建立远程连接，请检查网络、主机和 SSH 配置',
          ...(changed ? { code: error.code } : {}),
        });
      }
    } finally {
      const remaining = (connecting.get(req.user.id) || 1) - 1;
      if (remaining) connecting.set(req.user.id, remaining);
      else connecting.delete(req.user.id);
    }
  });
  const metricCache = new Map(),
    metricPending = new Map();
  app.post('/api/servers/:id/monitor', requirePermission('server.connect'), async (req, res) => {
    const row = await getRow(req.params.id);
    if (!row.fingerprint)
      return res.status(409).json({
        error: '请先由管理员或有修改权限的成员验证 SSH 主机指纹',
        code: 'HOST_KEY_REQUIRED',
      });
    try {
      const cached = metricCache.get(row.id);
      let metrics = cached && cached.expires > Date.now() ? cached.metrics : null;
      if (!metrics) {
        if (!metricPending.has(row.id)) {
          const pending = readMetrics(row, decrypt(row.credentials, key, row.id))
            .then((value) => {
              metricCache.set(row.id, { metrics: value, expires: Date.now() + 3500 });
              return value;
            })
            .finally(() => metricPending.delete(row.id));
          metricPending.set(row.id, pending);
        }
        metrics = await metricPending.get(row.id);
      }
      await audit(req, 'server.monitor', row, {
        cpu: metrics.cpu,
        memoryPercent: Math.round(metrics.memory.percent),
      });
      res.json(metrics);
    } catch (error) {
      await audit(
        req,
        'server.monitor',
        row,
        { reason: error.code === 'HOST_KEY_CHANGED' ? 'host_key_changed' : 'metrics_unavailable' },
        'failed',
      );
      res.status(error.code === 'HOST_KEY_CHANGED' ? 409 : 502).json({
        error:
          error.code === 'HOST_KEY_CHANGED'
            ? 'SSH 主机指纹已变化，请重新核实'
            : '监控读取失败，请检查目标系统、网络及账号权限',
        ...(error.code === 'HOST_KEY_CHANGED' ? { code: error.code } : {}),
      });
    }
  });
  app.get('/api/connections', async (req, res) => {
    const [rows] = await db.query(
      `SELECT c.*,a.username,a.user_id,r.state AS recording_state FROM connections c LEFT JOIN connection_actors a ON a.connection_id=c.id LEFT JOIN recordings r ON r.connection_id=c.id ORDER BY c.created_at DESC,c.id DESC LIMIT 100`,
    );
    res.json(rows);
  });
  app.get('/api/audit', async (req, res) => {
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 30))),
      offset = Math.max(0, Math.min(100000, Math.floor(Number(req.query.offset) || 0))),
      where = [],
      params = [];
    if (req.user.role !== 'admin') {
      where.push('actor_id=?');
      params.push(req.user.id);
    }
    if (req.query.q) {
      where.push('(actor_username LIKE ? OR server_name LIKE ? OR action LIKE ?)');
      for (let i = 0; i < 3; i++) params.push('%' + String(req.query.q).slice(0, 100) + '%');
    }
    if (req.query.outcome && ['success', 'failed', 'denied'].includes(req.query.outcome)) {
      where.push('outcome=?');
      params.push(req.query.outcome);
    }
    if (req.query.server_id) {
      where.push('server_id=?');
      params.push(String(req.query.server_id).slice(0, 36));
    }
    if (req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) {
      where.push('created_at>=?');
      params.push(req.query.from + ' 00:00:00');
    }
    if (req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
      where.push('created_at<DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(req.query.to + ' 00:00:00');
    }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const [[count]] = await db.execute(
      'SELECT COUNT(*) AS total FROM audit_events' + clause,
      params,
    );
    const [rows] = await db.query(
      'SELECT * FROM audit_events' + clause + ' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
      [...params, limit, offset],
    );
    res.json({
      rows: rows.map((r) => ({ ...r, details: parseJSON(r.details) })),
      total: count.total,
      limit,
      offset,
    });
  });
  app.get('/api/recordings/:id', requireAdmin, async (req, res) => {
    const [[row]] = await db.execute('SELECT * FROM recordings WHERE connection_id=?', [
      req.params.id,
    ]);
    if (!row) return res.status(404).json({ error: '录制不存在' });
    const from = Math.max(0, Math.floor(Number(req.query.from) || 0)),
      limit = Math.min(300, Math.max(1, Number(req.query.limit) || 200));
    const data = await readRecording({
      id: row.connection_id,
      dir: recordingDir,
      key,
      from,
      limit,
      meta: row,
    });
    if (from === 0)
      await audit(
        req,
        'ssh.recording.view',
        { id: null, name: row.server_name },
        { connectionId: row.connection_id },
      );
    res.json({ meta: row, ...data });
  });
  app.get('/api/system', (req, res) =>
    res.json({
      database: 'MySQL',
      gateway: config.gatewayHost + ':' + config.gatewayPort,
      publicUrl: config.publicUrl,
      encryption: 'AES-256-GCM',
      recording: config.recording,
      deployment: config.production ? '公网多人' : '本机多人开发',
      version: '2.0.0',
    }),
  );
  mountCloudRoutes(app, { db, key, requireAdmin, requirePermission, audit, getRow });
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  if (rootDir) {
    app.use(express.static(path.join(rootDir, 'dist')));
    app.get('/{*path}', (req, res) => res.sendFile(path.join(rootDir, 'dist/index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.name === 'ZodError')
      return res.status(400).json({ error: error.issues[0]?.message || '输入格式不正确' });
    if (error.type === 'entity.parse.failed')
      return res.status(400).json({ error: 'JSON 格式不正确' });
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '此账号已存在' });
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')
      return res.status(502).json({ error: '目标不可达，请检查地址、端口或网络' });
    res
      .status(error.status || 500)
      .json({ error: error.status ? error.message : '服务暂时不可用，请检查服务日志' });
  });
  app.harborClose = () => {
    clearInterval(cleanup);
  };
  return app;
}
