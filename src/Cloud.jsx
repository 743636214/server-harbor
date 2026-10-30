import { PasswordInput } from './PasswordInput.jsx';
import React, { useEffect, useState } from 'react';
import {
  Cloud,
  KeyRound,
  Plus,
  Pencil,
  Trash2,
  ShieldCheck,
  RefreshCw,
  LoaderCircle,
  ArrowUpRight,
} from 'lucide-react';
import { api, json } from './client.mjs';
export const cloudNames = { tencent: '腾讯云', alibaba: '阿里云', huawei: '华为云', aws: 'AWS' };
export function CloudPanel({ Dialog, user, notify }) {
  const [accounts, setAccounts] = useState([]),
    [editing, setEditing] = useState(null),
    [removing, setRemoving] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const admin = user.role === 'admin';
  const load = () =>
    api('/cloud/credentials')
      .then(setAccounts)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const empty = {
    name: '',
    provider: 'tencent',
    default_region: '',
    project_id: '',
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    active: true,
    clearToken: false,
  };
  const field = (key, value) => setEditing((v) => ({ ...v, [key]: value }));
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(
        '/cloud/credentials' + (editing.id ? '/' + editing.id : ''),
        json(editing.id ? 'PUT' : 'POST', editing),
      );
      setEditing(null);
      notify('云账号已加密保存');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">CLOUD / CREDENTIAL VAULT</div>
        <div className="title-row">
          <div>
            <h1>
              云账号与密钥<span className="title-dot">.</span>
            </h1>
            <p>统一维护多云 API 密钥，在服务器详情关联区域与安全组。</p>
          </div>
          {admin && (
            <button
              className="btn primary"
              onClick={() => {
                setError('');
                setEditing(empty);
              }}
            >
              <Plus size={16} />
              添加云账号
            </button>
          )}
        </div>
      </div>
      <div className="cloud-provider-pills">
        {Object.entries(cloudNames).map(([k, v]) => (
          <span key={k}>
            <Cloud size={14} />
            {v}
          </span>
        ))}
      </div>
      {error && !editing && <div className="form-error">{error}</div>}
      <div className="members-list">
        {accounts.length ? (
          accounts.map((a) => (
            <div className="member-row" key={a.id}>
              <div className="member-avatar">
                <Cloud size={20} />
              </div>
              <div className="member-info">
                <b>
                  {a.name} <code>{cloudNames[a.provider]}</code>
                </b>
                <small>
                  {a.default_region || '未设置默认区域'}{' '}
                  {admin && a.keyHint ? ' · ' + a.keyHint : ''}
                  {a.provider === 'huawei' && a.project_id ? ' · 已配置项目 ID' : ''}
                </small>
              </div>
              <span className={'member-state ' + (!a.active ? 'disabled' : '')}>
                {a.active ? '可用' : '已停用'}
              </span>
              {admin && (
                <>
                  <button
                    className="btn secondary"
                    onClick={() => {
                      setError('');
                      setEditing({
                        ...empty,
                        ...a,
                        accessKeyId: '',
                        secretAccessKey: '',
                        sessionToken: '',
                      });
                    }}
                  >
                    <Pencil size={14} />
                    维护密钥
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={'删除云账号 ' + a.name}
                    onClick={() => setRemoving(a)}
                  >
                    <Trash2 size={15} />
                  </button>
                </>
              )}
            </div>
          ))
        ) : (
          <div className="empty-state">
            <KeyRound size={30} />
            <h3>还没有云账号</h3>
            <p>
              {admin
                ? '添加 API 密钥后，即可为服务器配置安全组。'
                : '请联系管理员添加云账号，并授予安全组操作权限。'}
            </p>
          </div>
        )}
      </div>
      <div className="connection-hint">
        <ShieldCheck size={20} />
        <div>
          <b>密钥只在后端解密使用</b>
          <p>
            Secret
            不会回传浏览器。仅管理员可维护云账号；已授予“安全组管理”的成员可以查看与调整规则。云端密钥本身也必须具备对应安全组
            API 权限。
          </p>
        </div>
      </div>
      {editing && (
        <Dialog
          title={editing.id ? '维护云账号与密钥' : '添加云账号'}
          subtitle="密钥使用 AES-256-GCM 加密保存，不会写入操作日志。"
          onClose={() => setEditing(null)}
          wide
        >
          <form className="editor-form" onSubmit={save}>
            <div className="form-section">
              <div className="form-grid">
                <label>
                  账号名称
                  <input
                    autoFocus
                    required
                    maxLength={100}
                    value={editing.name}
                    onChange={(e) => field('name', e.target.value)}
                    placeholder="例如：生产环境腾讯云"
                  />
                </label>
                <label>
                  云厂商
                  <select
                    value={editing.provider}
                    onChange={(e) => field('provider', e.target.value)}
                  >
                    {Object.entries(cloudNames).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                AccessKey ID / SecretId
                <input
                  required={!editing.id}
                  autoComplete="off"
                  value={editing.accessKeyId}
                  onChange={(e) => field('accessKeyId', e.target.value)}
                  placeholder={editing.id ? '留空保留现有 ID' : '输入访问密钥 ID'}
                />
              </label>
              <label>
                AccessKey Secret / SecretKey
                <PasswordInput
                  required={!editing.id}

                  autoComplete="new-password"
                  value={editing.secretAccessKey}
                  onChange={(e) => field('secretAccessKey', e.target.value)}
                  placeholder={editing.id ? '留空保留现有 Secret' : '输入访问密钥 Secret'}
                />
              </label>
              <div className="form-grid">
                <label>
                  默认区域
                  <input
                    value={editing.default_region}
                    onChange={(e) => field('default_region', e.target.value)}
                    placeholder={
                      {
                        tencent: 'ap-guangzhou',
                        alibaba: 'cn-hangzhou',
                        huawei: 'cn-north-4',
                        aws: 'ap-southeast-1',
                      }[editing.provider]
                    }
                  />
                </label>
                <label>
                  项目 ID（华为云）
                  <input
                    value={editing.project_id}
                    onChange={(e) => field('project_id', e.target.value)}
                    placeholder="华为云区域项目 ID"
                  />
                </label>
              </div>
              <label>
                临时凭据 Token（可选）
                <PasswordInput
                  autoComplete="new-password"
                  value={editing.sessionToken}
                  onChange={(e) => field('sessionToken', e.target.value)}
                  placeholder={
                    editing.id ? '留空保留原 Token' : 'STS / SecurityToken / SessionToken'
                  }
                />
              </label>
              {editing.id && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={editing.clearToken}
                    onChange={(e) => field('clearToken', e.target.checked)}
                  />
                  清除原来的临时 Token
                </label>
              )}
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={editing.active}
                  onChange={(e) => field('active', e.target.checked)}
                />
                启用此云账号
              </label>
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="dialog-footer">
              <button type="button" className="btn secondary" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="btn primary" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}
                加密保存
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {removing && (
        <Dialog title="删除云账号？" subtitle={removing.name} onClose={() => setRemoving(null)}>
          <div className="dialog-copy">
            将删除此处保存的 API 密钥。仍有关联服务器时无法删除，可以先停用。
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="dialog-footer">
            <button className="btn secondary" onClick={() => setRemoving(null)}>
              取消
            </button>
            <button
              className="btn danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api('/cloud/credentials/' + removing.id, json('DELETE', {}));
                  setRemoving(null);
                  await load();
                  notify('云账号已删除');
                } catch (e) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认删除
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
export function SecurityGroupDialog({ row, Dialog, onClose, onManageCredentials }) {
  const [accounts, setAccounts] = useState([]),
    [binding, setBinding] = useState({
      credential_id: '',
      region: '',
      security_group_id: '',
      project_id: '',
    }),
    [groups, setGroups] = useState([]),
    [rules, setRules] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [rule, setRule] = useState(null),
    [remove, setRemove] = useState(null);
  const account = accounts.find((a) => a.id === binding.credential_id);
  async function loadRules() {
    setBusy(true);
    setError('');
    try {
      setRules(await api(`/servers/${row.id}/security-rules`));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    Promise.all([api('/cloud/credentials'), api(`/servers/${row.id}/cloud`)])
      .then(([list, saved]) => {
        if (!active) return;
        setAccounts(list);
        if (saved) {
          setBinding(saved);
          loadRules();
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [row.id]);
  const change = (key, value) => {
    setBinding((v) => ({ ...v, [key]: value }));
    setRules(null);
  };
  async function saveBinding(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/servers/${row.id}/cloud`, json('PUT', binding));
      await loadRules();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function addRule(e) {
    e.preventDefault();
    const match = rule.ports.trim().match(/^(\d{1,5})(?:\s*[-/]\s*(\d{1,5}))?$/);
    if (!match) {
      setError('端口格式应为 80 或 8000-9000');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(
        `/servers/${row.id}/security-rules`,
        json('POST', {
          direction: rule.direction,
          protocol: rule.protocol,
          from: Number(match[1]),
          to: Number(match[2] || match[1]),
          cidr: rule.cidr,
          description: rule.description,
        }),
      );
      setRule(null);
      await loadRules();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={'安全组 · ' + row.name}
      subtitle="配置云端端口放行规则。规则对该安全组关联的所有云实例生效。"
      onClose={onClose}
      wide
      className="security-dialog"
    >
      <div className="security-body">
        {!accounts.length ? (
          <div className="empty-state">
            <KeyRound size={28} />
            <h3>请先维护云 API 密钥</h3>
            <p>支持腾讯云、阿里云、华为云与 AWS。</p>
            <button className="btn primary" onClick={onManageCredentials}>
              前往云账号与密钥
              <ArrowUpRight size={14} />
            </button>
          </div>
        ) : (
          <>
            <form className="binding-form" onSubmit={saveBinding}>
              <div className="form-grid">
                <label>
                  云账号
                  <select
                    required
                    value={binding.credential_id}
                    onChange={(e) => {
                      const a = accounts.find((a) => a.id === e.target.value);
                      setBinding({
                        credential_id: e.target.value,
                        region: a?.default_region || '',
                        project_id: a?.project_id || '',
                        security_group_id: '',
                      });
                      setGroups([]);
                      setRules(null);
                    }}
                  >
                    <option value="">选择已保存的云账号</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id} disabled={!a.active}>
                        {a.name} · {cloudNames[a.provider]}
                        {a.active ? '' : '（已停用）'}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  区域
                  <input
                    required
                    value={binding.region}
                    onChange={(e) => change('region', e.target.value)}
                    placeholder="例如：ap-guangzhou"
                  />
                </label>
              </div>
              {account?.provider === 'huawei' && (
                <label>
                  该区域的项目 ID
                  <input
                    required
                    value={binding.project_id}
                    onChange={(e) => change('project_id', e.target.value)}
                    placeholder="华为云 project_id"
                  />
                </label>
              )}
              <label>
                安全组 ID
                <div className="group-picker">
                  <input
                    required
                    list={'groups-' + row.id}
                    value={binding.security_group_id}
                    onChange={(e) => change('security_group_id', e.target.value)}
                    placeholder="输入安全组 ID 或先读取列表"
                  />
                  <datalist id={'groups-' + row.id}>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </datalist>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy || !binding.credential_id || !binding.region}
                    onClick={async () => {
                      setBusy(true);
                      setError('');
                      try {
                        setGroups(
                          await api(
                            `/cloud/credentials/${binding.credential_id}/groups?` +
                              new URLSearchParams({
                                region: binding.region,
                                project_id: binding.project_id,
                              }),
                          ),
                        );
                      } catch (e) {
                        setError(e.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <RefreshCw size={14} />
                    读取安全组
                  </button>
                </div>
              </label>
              {groups.length > 0 && (
                <select
                  aria-label="选择云端安全组"
                  value={binding.security_group_id}
                  onChange={(e) => change('security_group_id', e.target.value)}
                >
                  <option value="">从列表选择（{groups.length} 个）</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} · {g.id}
                    </option>
                  ))}
                </select>
              )}
              <div className="binding-actions">
                <button className="btn primary" disabled={busy}>
                  <ShieldCheck size={15} />
                  保存关联并读取规则
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(`/servers/${row.id}/cloud`, json('DELETE', {}));
                      setBinding({
                        credential_id: '',
                        region: '',
                        security_group_id: '',
                        project_id: '',
                      });
                      setRules(null);
                    } catch (e) {
                      setError(e.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  解除关联
                </button>
              </div>
              <p className="cloud-note">
                请确认所选安全组实际关联这台服务器。保存关联只保存管理映射，不会替云实例更换安全组；也不会修改操作系统防火墙。
              </p>
            </form>
            {error && <div className="form-error">{error}</div>}
            {rules && (
              <>
                <div className="section-heading">
                  <div>
                    <h2>
                      当前规则 <span>{rules.rules.length}</span>
                    </h2>
                    <p>
                      {cloudNames[rules.provider]} · {rules.account} ·{' '}
                      {rules.binding.security_group_id}
                    </p>
                  </div>
                  <div className="rule-toolbar">
                    <button className="btn secondary" disabled={busy} onClick={loadRules}>
                      <RefreshCw size={14} />
                      刷新
                    </button>
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={() => {
                        setError('');
                        setRule({
                          direction: 'ingress',
                          protocol: 'tcp',
                          ports: '',
                          cidr: '',
                          description: '',
                        });
                      }}
                    >
                      <Plus size={14} />
                      开放端口
                    </button>
                  </div>
                </div>
                <div className="security-rules">
                  {rules.rules.map((r, i) => (
                    <div className="security-rule" key={r.direction + r.id + i}>
                      <div>
                        <b>
                          {r.direction === 'ingress' ? '入站' : '出站'} · {r.protocol.toUpperCase()}{' '}
                          · {r.ports}
                        </b>
                        <small>
                          {r.cidr} · {r.action === 'deny' ? '拒绝' : '允许'}
                        </small>
                        {r.description && <small>{r.description}</small>}
                      </div>
                      <button
                        className="icon-btn"
                        disabled={!r.canDelete || busy}
                        title={
                          r.canDelete ? '删除此规则' : '旧版规则缺少稳定 ID，请通过云控制台管理'
                        }
                        aria-label="删除安全组规则"
                        onClick={() => {
                          setError('');
                          setRemove(r);
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                  {!rules.rules.length && <p className="cloud-note">安全组没有返回规则。</p>}
                </div>
              </>
            )}
            {busy && (
              <div className="cloud-loading">
                <LoaderCircle className="spin" size={16} />
                正在调用云 API…
              </div>
            )}
          </>
        )}
      </div>
      {rule && (
        <Dialog
          title="开放端口"
          subtitle={`${row.name} · ${rules.binding.security_group_id}`}
          onClose={() => setRule(null)}
        >
          <form className="editor-form" onSubmit={addRule}>
            <div className="form-section">
              <div className="form-grid">
                <label>
                  方向
                  <select
                    value={rule.direction}
                    onChange={(e) => setRule({ ...rule, direction: e.target.value })}
                  >
                    <option value="ingress">入站 · 访问服务器</option>
                    <option value="egress">出站 · 服务器访问外部</option>
                  </select>
                </label>
                <label>
                  协议
                  <select
                    value={rule.protocol}
                    onChange={(e) => setRule({ ...rule, protocol: e.target.value })}
                  >
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                  </select>
                </label>
              </div>
              <label>
                端口 / 端口范围
                <input
                  autoFocus
                  required
                  value={rule.ports}
                  onChange={(e) => setRule({ ...rule, ports: e.target.value })}
                  placeholder="例如：443 或 8000-9000"
                />
              </label>
              <label>
                {rule.direction === 'ingress' ? '来源' : '目标'} CIDR
                <input
                  required
                  value={rule.cidr}
                  onChange={(e) => setRule({ ...rule, cidr: e.target.value })}
                  placeholder="例如：203.0.113.5/32 或 2001:db8::/64"
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={rule.cidr === '0.0.0.0/0'}
                  onChange={(e) => setRule({ ...rule, cidr: e.target.checked ? '0.0.0.0/0' : '' })}
                />
                允许所有 IPv4 地址（0.0.0.0/0）
              </label>
              {rule.cidr.endsWith('/0') && (
                <div className="recording-notice">
                  此范围覆盖整个互联网，请确认该端口确实需要公开。
                </div>
              )}
              <label>
                用途说明
                <input
                  maxLength={100}
                  value={rule.description}
                  onChange={(e) => setRule({ ...rule, description: e.target.value })}
                  placeholder="例如：HTTPS 网站入口"
                />
              </label>
              <p className="cloud-note">
                将新增一条允许规则：{rule.direction === 'ingress' ? '入站' : '出站'}{' '}
                {rule.protocol.toUpperCase()} {rule.ports || '待填写'}，范围 {rule.cidr || '待填写'}
                。同一安全组关联的其他实例也会受到影响。
              </p>
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="dialog-footer">
              <button type="button" className="btn secondary" onClick={() => setRule(null)}>
                取消
              </button>
              <button className="btn primary" disabled={busy}>
                应用放行规则
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {remove && (
        <Dialog title="删除这条安全组规则？" onClose={() => setRemove(null)}>
          <div className="dialog-copy">
            {remove.direction === 'ingress' ? '入站' : '出站'} · {remove.protocol.toUpperCase()} ·{' '}
            {remove.ports}
            <br />
            范围：{remove.cidr}
            <br />
            安全组：{rules.binding.security_group_id}
            <p>删除可能中断现有连接，操作会记入审计日志。</p>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="dialog-footer">
            <button className="btn secondary" onClick={() => setRemove(null)}>
              取消
            </button>
            <button
              className="btn danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await api(
                    `/servers/${row.id}/security-rules/delete`,
                    json('POST', { token: remove.deleteToken }),
                  );
                  setRemove(null);
                  await loadRules();
                } catch (e) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认删除规则
            </button>
          </div>
        </Dialog>
      )}
    </Dialog>
  );
}
