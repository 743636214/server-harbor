import { z } from 'zod';
import { isIP } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { encrypt, decrypt } from '../crypto.mjs';
import { transaction } from '../permissions.mjs';
import { adapter, providers } from './adapters.mjs';
const regionSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, '区域格式不正确，例如 ap-guangzhou / cn-hangzhou');
const projectSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_-]{0,128}$/)
  .default('');
const credentialSchema = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.enum(['tencent', 'alibaba', 'huawei', 'aws']),
  default_region: z.string().trim().max(64).default(''),
  project_id: projectSchema,
  accessKeyId: z.string().trim().max(256).optional(),
  secretAccessKey: z.string().max(4096).optional(),
  sessionToken: z.string().max(16384).optional(),
  clearToken: z.boolean().default(false),
  active: z.boolean().default(true),
});
const bindingSchema = z.object({
  credential_id: z.string().uuid(),
  region: regionSchema,
  security_group_id: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9-]{3,128}$/, '安全组 ID 格式不正确'),
  project_id: projectSchema,
});
const cidrSchema = z
  .string()
  .trim()
  .refine((value) => {
    const [ip, prefix, ...rest] = value.split('/');
    const version = isIP(ip);
    return (
      !rest.length &&
      version &&
      prefix !== undefined &&
      /^\d+$/.test(prefix) &&
      Number(prefix) >= (version === 6 ? 0 : 0) &&
      Number(prefix) <= (version === 6 ? 128 : 32)
    );
  }, '请输入明确的 IPv4 / IPv6 CIDR，例如 203.0.113.5/32');
const ruleSchema = z
  .object({
    direction: z.enum(['ingress', 'egress']),
    protocol: z.enum(['tcp', 'udp']),
    from: z.coerce.number().int().min(1).max(65535),
    to: z.coerce.number().int().min(1).max(65535),
    cidr: cidrSchema,
    description: z.string().trim().max(100).default(''),
  })
  .refine((value) => value.to >= value.from, '结束端口不能小于起始端口');
const ruleHash = (rule) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        rule.id,
        rule.direction,
        rule.protocol,
        rule.ports,
        rule.cidr,
        rule.description,
        rule.action,
      ]),
    )
    .digest('hex');
const errorStatus = (message, status = 400) =>
  Object.assign(new Error(message), { status, harborPublic: true });
export function mountCloudRoutes(app, { db, key, requireAdmin, requirePermission, audit, getRow }) {
  const guard = requirePermission('cloud.manage');
  const credential = async (id, active = false) => {
    const [[row]] = await db.execute('SELECT * FROM cloud_credentials WHERE id=?', [id]);
    if (!row) throw errorStatus('云账号不存在', 404);
    if (active && !row.active) throw errorStatus('该云账号已停用');
    return row;
  };
  const metadata = (row, admin = false) => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    default_region: row.default_region,
    project_id: row.project_id,
    active: Boolean(row.active),
    updated_at: row.updated_at,
    ...(admin
      ? {
          keyHint:
            '••••' + (decrypt(row.credentials, key, 'cloud:' + row.id).accessKeyId || '').slice(-4),
        }
      : {}),
  });
  const sdk = (row, region, project) =>
    adapter(
      row.provider,
      decrypt(row.credentials, key, 'cloud:' + row.id),
      region,
      project || row.project_id,
    );
  const context = async (serverId) => {
    const server = await getRow(serverId),
      [[binding]] = await db.execute('SELECT * FROM server_cloud_bindings WHERE server_id=?', [
        serverId,
      ]);
    if (!binding) throw errorStatus('请先关联云账号、区域与安全组');
    const account = await credential(binding.credential_id, true);
    return { server, binding, account, client: sdk(account, binding.region, binding.project_id) };
  };
  const cloudError = (res, error) => {
    if (error.harborPublic) return res.status(error.status).json({ error: error.message });
    const raw = String(error.code || error.errorCode || error.name || 'CLOUD_API_ERROR'),
      code = raw.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100);
    res.status(502).json({
      error: `云 API 调用失败（${code}）。请检查密钥、区域、项目 ID 和安全组权限；请求结果不确定时请刷新规则后再操作。`,
    });
  };
  app.get('/api/cloud/providers', guard, (req, res) => res.json(providers));
  app.get('/api/cloud/credentials', guard, async (req, res) => {
    const [rows] = await db.query('SELECT * FROM cloud_credentials ORDER BY name');
    res.json(rows.map((r) => metadata(r, req.user.role === 'admin')));
  });
  app.post('/api/cloud/credentials', requireAdmin, async (req, res) => {
    const data = credentialSchema.parse(req.body);
    if (data.default_region) regionSchema.parse(data.default_region);
    if (!data.accessKeyId || !data.secretAccessKey)
      throw errorStatus('请输入 AccessKey ID 和 Secret / SecretKey');
    const id = randomUUID(),
      secrets = {
        accessKeyId: data.accessKeyId,
        secretAccessKey: data.secretAccessKey,
        sessionToken: data.sessionToken || '',
      };
    await transaction(db, async (store) => {
      await store.execute(
        'INSERT INTO cloud_credentials(id,name,provider,default_region,project_id,credentials,active) VALUES (?,?,?,?,?,?,?)',
        [
          id,
          data.name,
          data.provider,
          data.default_region,
          data.project_id,
          encrypt(secrets, key, 'cloud:' + id),
          data.active,
        ],
      );
      await audit(
        req,
        'cloud.credential.create',
        null,
        { account: data.name, provider: data.provider },
        'success',
        store,
      );
    });
    res.status(201).json({ ok: true, id });
  });
  app.put('/api/cloud/credentials/:id', requireAdmin, async (req, res) => {
    const old = await credential(req.params.id),
      data = credentialSchema.parse(req.body);
    if (data.default_region) regionSchema.parse(data.default_region);
    const previous = decrypt(old.credentials, key, 'cloud:' + old.id);
    if (data.provider !== old.provider && (!data.accessKeyId || !data.secretAccessKey))
      throw errorStatus('更换云厂商时需要同时填写新的 ID 和 Secret');
    const secrets = {
      accessKeyId: data.accessKeyId || previous.accessKeyId,
      secretAccessKey: data.secretAccessKey || previous.secretAccessKey,
      sessionToken: data.clearToken ? '' : data.sessionToken || previous.sessionToken || '',
    };
    const [[uses]] = await db.execute(
      'SELECT COUNT(*) AS total FROM server_cloud_bindings WHERE credential_id=?',
      [old.id],
    );
    if (uses.total && data.provider !== old.provider)
      throw errorStatus('此账号已有服务器关联，请先解除关联后再更换云厂商');
    await transaction(db, async (store) => {
      await store.execute(
        'UPDATE cloud_credentials SET name=?,provider=?,default_region=?,project_id=?,credentials=?,active=? WHERE id=?',
        [
          data.name,
          data.provider,
          data.default_region,
          data.project_id,
          encrypt(secrets, key, 'cloud:' + old.id),
          data.active,
          old.id,
        ],
      );
      await audit(
        req,
        'cloud.credential.update',
        null,
        {
          account: data.name,
          provider: data.provider,
          active: data.active,
          keysUpdated: Boolean(
            data.accessKeyId || data.secretAccessKey || data.sessionToken || data.clearToken,
          ),
        },
        'success',
        store,
      );
    });
    res.json({ ok: true });
  });
  app.delete('/api/cloud/credentials/:id', requireAdmin, async (req, res) => {
    const row = await credential(req.params.id);
    const [[count]] = await db.execute(
      'SELECT COUNT(*) AS total FROM server_cloud_bindings WHERE credential_id=?',
      [row.id],
    );
    if (count.total)
      throw errorStatus('此云账号仍有关联服务器，请先解除关联；也可以先停用账号', 409);
    await transaction(db, async (store) => {
      await store.execute('DELETE FROM cloud_credentials WHERE id=?', [row.id]);
      await audit(
        req,
        'cloud.credential.delete',
        null,
        { account: row.name, provider: row.provider },
        'success',
        store,
      );
    });
    res.json({ ok: true });
  });
  app.get('/api/cloud/credentials/:id/groups', guard, async (req, res) => {
    try {
      const row = await credential(req.params.id, true),
        region = regionSchema.parse(req.query.region || row.default_region),
        project = projectSchema.parse(req.query.project_id || row.project_id);
      const groups = await sdk(row, region, project).groups();
      await audit(req, 'cloud.groups.list', null, {
        account: row.name,
        provider: row.provider,
        region,
      });
      res.json(groups);
    } catch (error) {
      if (error.name === 'ZodError') throw error;
      await audit(req, 'cloud.groups.list', null, { credentialId: req.params.id }, 'failed');
      cloudError(res, error);
    }
  });
  app.get('/api/servers/:id/cloud', guard, async (req, res) => {
    await getRow(req.params.id);
    const [[row]] = await db.execute('SELECT * FROM server_cloud_bindings WHERE server_id=?', [
      req.params.id,
    ]);
    res.json(row || null);
  });
  app.put('/api/servers/:id/cloud', guard, async (req, res) => {
    const server = await getRow(req.params.id),
      data = bindingSchema.parse(req.body),
      account = await credential(data.credential_id, true);
    await transaction(db, async (store) => {
      await store.execute(
        'INSERT INTO server_cloud_bindings(server_id,credential_id,region,security_group_id,project_id) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE credential_id=VALUES(credential_id),region=VALUES(region),security_group_id=VALUES(security_group_id),project_id=VALUES(project_id)',
        [server.id, data.credential_id, data.region, data.security_group_id, data.project_id],
      );
      await audit(
        req,
        'cloud.binding.update',
        server,
        {
          provider: account.provider,
          account: account.name,
          region: data.region,
          securityGroupId: data.security_group_id,
        },
        'success',
        store,
      );
    });
    res.json({ ok: true });
  });
  app.delete('/api/servers/:id/cloud', guard, async (req, res) => {
    const server = await getRow(req.params.id);
    await transaction(db, async (store) => {
      await store.execute('DELETE FROM server_cloud_bindings WHERE server_id=?', [server.id]);
      await audit(req, 'cloud.binding.delete', server, {}, 'success', store);
    });
    res.json({ ok: true });
  });
  app.get('/api/servers/:id/security-rules', guard, async (req, res) => {
    let target;
    try {
      target = await context(req.params.id);
      const data = await target.client.list(target.binding.security_group_id);
      await audit(req, 'cloud.rules.list', target.server, {
        provider: target.account.provider,
        securityGroupId: target.binding.security_group_id,
      });
      res.json({
        provider: target.account.provider,
        account: target.account.name,
        binding: target.binding,
        version: data.version,
        rules: data.rules.map((rule) => ({
          ...rule,
          raw: undefined,
          canDelete: Boolean(rule.id),
          deleteToken: rule.id
            ? encrypt(
                {
                  binding: target.binding,
                  version: data.version,
                  hash: ruleHash(rule),
                  id: rule.id,
                  direction: rule.direction,
                  expires: Date.now() + 300000,
                },
                key,
                'cloud-rule:' + target.server.id,
              )
            : null,
        })),
      });
    } catch (error) {
      await audit(
        req,
        'cloud.rules.list',
        target?.server || { id: req.params.id, name: '' },
        {},
        'failed',
      );
      cloudError(res, error);
    }
  });
  app.post('/api/servers/:id/security-rules', guard, async (req, res) => {
    const rule = ruleSchema.parse(req.body);
    let target;
    try {
      target = await context(req.params.id);
      const details = {
        provider: target.account.provider,
        securityGroupId: target.binding.security_group_id,
        rule,
      };
      await audit(req, 'cloud.rule.add', target.server, details, 'requested');
      await target.client.add(target.binding.security_group_id, rule);
      await audit(req, 'cloud.rule.add', target.server, details);
      res.json({ ok: true });
    } catch (error) {
      await audit(
        req,
        'cloud.rule.add',
        target?.server || { id: req.params.id, name: '' },
        { rule },
        'failed',
      );
      cloudError(res, error);
    }
  });
  app.post('/api/servers/:id/security-rules/delete', guard, async (req, res) => {
    let target;
    try {
      target = await context(req.params.id);
      let ticket;
      try {
        ticket = decrypt(String(req.body.token || ''), key, 'cloud-rule:' + target.server.id);
      } catch {
        throw errorStatus('规则删除令牌无效，请刷新规则', 400);
      }
      if (
        ticket.expires < Date.now() ||
        JSON.stringify(ticket.binding) !== JSON.stringify(target.binding)
      )
        throw errorStatus('关联信息或规则已变化，请刷新后重新选择', 409);
      const fresh = await target.client.list(target.binding.security_group_id);
      if (ticket.version && ticket.version !== fresh.version)
        throw errorStatus('云安全组规则版本已变化，请刷新后再删除', 409);
      const current = fresh.rules.find(
        (r) =>
          r.id === ticket.id && r.direction === ticket.direction && ruleHash(r) === ticket.hash,
      );
      if (!current) throw errorStatus('规则已变化或不存在，请刷新', 409);
      const details = {
        provider: target.account.provider,
        securityGroupId: target.binding.security_group_id,
        rule: {
          id: current.id,
          direction: current.direction,
          protocol: current.protocol,
          ports: current.ports,
          cidr: current.cidr,
        },
      };
      await audit(req, 'cloud.rule.delete', target.server, details, 'requested');
      await target.client.remove(target.binding.security_group_id, current, fresh.version);
      await audit(req, 'cloud.rule.delete', target.server, details);
      res.json({ ok: true });
    } catch (error) {
      await audit(
        req,
        'cloud.rule.delete',
        target?.server || { id: req.params.id, name: '' },
        {},
        'failed',
      );
      cloudError(res, error);
    }
  });
}
