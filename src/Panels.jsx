import { PasswordInput } from './PasswordInput.jsx';
import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Users,
  ShieldCheck,
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Play,
  Pause,
  RotateCcw,
  LoaderCircle,
  FileClock,
  KeyRound,
  UnlockKeyhole,
} from 'lucide-react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, json } from './client.mjs';
const labels = {
  'server.create': '新增服务器',
  'server.edit': '修改服务器 / 信任指纹',
  'server.delete': '删除服务器',
  'server.connect': 'SSH 连接与监控',
  'cloud.manage': '安全组管理',
};
export const actionLabels = {
  'server.monitor': '读取服务器监控',
  'cloud.credential.create': '新增云密钥',
  'cloud.credential.update': '维护云密钥',
  'cloud.credential.delete': '删除云密钥',
  'cloud.groups.list': '读取云安全组列表',
  'cloud.binding.update': '关联云安全组',
  'cloud.binding.delete': '解除云安全组关联',
  'cloud.rules.list': '读取安全组规则',
  'cloud.rule.add': '新增放行规则',
  'cloud.rule.delete': '删除安全组规则',
  'server.create': '新增服务器',
  'server.update': '修改服务器',
  'server.delete': '删除服务器',
  'server.favorite': '收藏设置',
  'server.fingerprint.inspect': '检查主机指纹',
  'server.fingerprint.trust': '信任主机指纹',
  'ssh.request': '发起 SSH 连接',
  'ssh.connected': '终端已接入',
  'ssh.closed': '终端已断开',
  'ssh.failed': '连接失败',
  'ssh.interrupted': '服务重启中断',
  'ssh.connect': 'SSH 登录',
  'ssh.recording.view': '查看会话录制',
  'account.bootstrap': '初始化管理员',
  'account.login': '账号登录',
  'account.login.lock': '登录失败锁定账号',
  'account.login.unlock': '次日自动解除登录锁定',
  'account.login.admin_unlock': '管理员解除登录锁定',
  'account.logout': '账号退出',
  'account.create': '创建账号',
  'account.update': '调整账号或权限',
  'account.password.change': '修改本人密码',
  'permission.denied': '权限拦截',
};
const outcomeLabels = { success: '成功', failed: '失败', denied: '已拒绝', requested: '已发起' };
export function UsersPanel({ Dialog, notify }) {
  const [users, setUsers] = useState([]),
    [editing, setEditing] = useState(null),
    [busy, setBusy] = useState(false),
    [unlocking, setUnlocking] = useState(null),
    [error, setError] = useState('');
  const load = () =>
    api('/users')
      .then(setUsers)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const empty = {
    username: '',
    display_name: '',
    role: 'member',
    active: true,
    permissions: {
      'server.create': false,
      'server.edit': false,
      'server.delete': false,
      'server.connect': true,
      'cloud.manage': false,
    },
    password: '',
  };
  const update = (key, value) => setEditing((s) => ({ ...s, [key]: value }));
  async function unlock(user) {
    setUnlocking(user.id);
    setError('');
    try {
      const result = await api('/users/' + user.id + '/unlock', json('POST', {}));
      notify(result.message);
      await load();
    } catch (error) {
      setError(error.message);
    } finally {
      setUnlocking(null);
    }
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = { ...editing };
      if (!data.password) delete data.password;
      await api(
        '/users' + (editing.id ? '/' + editing.id : ''),
        json(editing.id ? 'PUT' : 'POST', data),
      );
      setEditing(null);
      notify('账号及权限已保存；该账号的旧登录和 SSH 会话已撤销');
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
        <div className="eyebrow">TEAM / ACCESS CONTROL</div>
        <div className="title-row">
          <div>
            <h1>
              成员与权限<span className="title-dot">.</span>
            </h1>
            <p>共同管理服务器，按账号明确授权。权限变更立即生效。</p>
          </div>
          <button
            className="btn primary"
            onClick={() => {
              setError('');
              setEditing(empty);
            }}
          >
            <Plus size={16} />
            添加成员
          </button>
        </div>
      </div>
      {error && !editing && <div className="form-error">{error}</div>}
      <div className="members-list">
        {users.map((u) => (
          <div className="member-row" key={u.id}>
            <div className="member-avatar">{u.username[0].toUpperCase()}</div>
            <div className="member-info">
              <b>
                {u.display_name} <code>@{u.username}</code>
              </b>
              <small>
                {u.role === 'admin'
                  ? '管理员 · 全部权限'
                  : Object.entries(u.permissions)
                      .filter(([, v]) => v)
                      .map(([k]) => labels[k])
                      .join('、') || '仅查看服务器'}
              </small>
            </div>
            <span
              className={'member-state ' + (!u.active || u.login_locked_until ? 'disabled' : '')}
              title={
                u.login_locked_until
                  ? `登录锁定至北京时间 ${new Date(u.login_locked_until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
                  : undefined
              }
            >
              {!u.active ? '已停用' : u.login_locked_until ? '登录已锁定 · 次日解封' : '已启用'}
            </span>
            {u.login_locked_until && (
              <button
                className="btn secondary"
                disabled={Boolean(unlocking)}
                onClick={() => unlock(u)}
                aria-label={'解除 ' + u.username + ' 的登录锁定'}
              >
                {unlocking === u.id ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <UnlockKeyhole size={14} />
                )}
                {unlocking === u.id ? '正在解锁…' : '解除登录锁定'}
              </button>
            )}
            <button
              className="btn secondary"
              onClick={() => {
                setError('');
                setEditing({ ...u, password: '' });
              }}
            >
              <Pencil size={14} />
              编辑权限
            </button>
          </div>
        ))}
      </div>
      <div className="connection-hint">
        <ShieldCheck size={20} />
        <div>
          <b>成员默认只能查看与连接</b>
          <p>
            新增、修改、删除必须由管理员明确授予。信任或更换 SSH
            主机指纹需要修改权限；收藏属于个人偏好。
          </p>
        </div>
      </div>
      {editing && (
        <Dialog
          title={editing.id ? '编辑账号与权限' : '添加成员'}
          subtitle="成员共享服务器库。修改权限、停用或重置密码会撤销该账号已有登录与连接。"
          onClose={() => setEditing(null)}
        >
          <form className="editor-form" onSubmit={save}>
            <div className="form-section">
              <div className="form-grid">
                <label>
                  登录账号
                  <input
                    autoFocus
                    required
                    pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}"
                    value={editing.username}
                    onChange={(e) => update('username', e.target.value)}
                    placeholder="例如：ops-zhang"
                  />
                </label>
                <label>
                  显示名称
                  <input
                    required
                    maxLength={100}
                    value={editing.display_name}
                    onChange={(e) => update('display_name', e.target.value)}
                    placeholder="例如：张工"
                  />
                </label>
              </div>
              <label>
                {editing.id ? '重置密码（留空保留）' : '初始密码'}
                <PasswordInput
                  autoComplete="new-password"
                  required={!editing.id}
                  minLength={10}
                  maxLength={128}
                  value={editing.password}
                  onChange={(e) => update('password', e.target.value)}
                  placeholder="至少 10 个字符"
                />
              </label>
              <label>
                角色
                <select value={editing.role} onChange={(e) => update('role', e.target.value)}>
                  <option value="member">普通成员 · 按下方授权</option>
                  <option value="admin">管理员 · 所有权限与账号管理</option>
                </select>
              </label>
              <div className="permissions-grid">
                {Object.entries(labels).map(([k, v]) => (
                  <label className="checkbox-label" key={k}>
                    <input
                      type="checkbox"
                      disabled={editing.role === 'admin'}
                      checked={editing.role === 'admin' || editing.permissions[k]}
                      onChange={(e) =>
                        update('permissions', { ...editing.permissions, [k]: e.target.checked })
                      }
                    />
                    {v}
                  </label>
                ))}
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={editing.active}
                  onChange={(e) => update('active', e.target.checked)}
                />
                启用此账号
              </label>
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="dialog-footer">
              <button type="button" className="btn secondary" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="btn primary" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
                保存权限
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
export function AuditPanel({ Dialog, user }) {
  const [data, setData] = useState({ rows: [], total: 0 }),
    [q, setQ] = useState(''),
    [outcome, setOutcome] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [offset, setOffset] = useState(0),
    [error, setError] = useState(''),
    [selected, setSelected] = useState(null),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api(
        '/audit?' +
          new URLSearchParams({ q, outcome, from, to, offset: String(offset), limit: '30' }),
      )
        .then((d) => {
          if (active) {
            setData(d);
            setError('');
          }
        })
        .catch((e) => active && setError(e.message))
        .finally(() => active && setLoading(false));
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [q, outcome, from, to, offset]);
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">SECURITY / AUDIT TRAIL</div>
        <h1>
          操作日志<span className="title-dot">.</span>
        </h1>
        <p>
          {user.role === 'admin'
            ? '查看所有成员的管理操作、权限变更与 SSH 连接活动。'
            : '查看你自己的管理操作与 SSH 连接活动。'}{' '}
          日志不保存 SSH 凭据明文。
        </p>
      </div>
      <div className="filterbar audit-filters">
        <div className="search">
          <Search size={16} />
          <input
            placeholder="搜索账号、服务器或动作…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
          />
        </div>
        <select
          aria-label="操作结果"
          value={outcome}
          onChange={(e) => {
            setOutcome(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">全部结果</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
          <option value="denied">已拒绝</option>
        </select>
        <input
          aria-label="开始日期"
          type="date"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setOffset(0);
          }}
        />
        <span>至</span>
        <input
          aria-label="结束日期"
          type="date"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setOffset(0);
          }}
        />
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="audit-table">
        <div className="audit-head">
          <span>时间 / 账号</span>
          <span>服务器</span>
          <span>操作</span>
          <span>结果 / 来源</span>
        </div>
        {loading ? (
          <div className="panel-loading">
            <LoaderCircle size={20} className="spin" />
            读取日志…
          </div>
        ) : data.rows.length ? (
          data.rows.map((row) => (
            <button className="audit-row" key={row.id} onClick={() => setSelected(row)}>
              <div>
                <time>{new Date(row.created_at).toLocaleString('zh-CN')}</time>
                <b>{row.actor_username}</b>
              </div>
              <div>
                <b>{row.server_name || '账号 / 工作空间'}</b>
                <small>{row.server_id || '—'}</small>
              </div>
              <div>
                {actionLabels[row.action] || row.action}
                <small>点击查看详情</small>
              </div>
              <div>
                <span className={'audit-outcome ' + row.outcome}>{outcomeLabels[row.outcome]}</span>
                <small>{row.ip || '系统任务'}</small>
              </div>
            </button>
          ))
        ) : (
          <div className="empty-state">
            <FileClock size={30} />
            <h3>没有匹配的操作记录</h3>
          </div>
        )}
      </div>
      <div className="pagination">
        <span>
          共 {data.total} 条 · 第 {Math.floor(offset / 30) + 1} 页
        </span>
        <button
          className="btn secondary"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 30))}
        >
          <ChevronLeft size={15} />
          上一页
        </button>
        <button
          className="btn secondary"
          disabled={offset + 30 >= data.total}
          onClick={() => setOffset(offset + 30)}
        >
          下一页
          <ChevronRight size={15} />
        </button>
      </div>
      {selected && (
        <Dialog
          title={actionLabels[selected.action] || selected.action}
          subtitle={`${selected.actor_username} · ${new Date(selected.created_at).toLocaleString('zh-CN')}`}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="audit-detail">
            <p>
              服务器：{selected.server_name || '—'}　结果：{outcomeLabels[selected.outcome]}
            </p>
            <p>来源地址：{selected.ip || '系统任务'}</p>
            <pre>{JSON.stringify(selected.details, null, 2)}</pre>
          </div>
        </Dialog>
      )}
    </>
  );
}
export function RecordingDialog({ id, Dialog, onClose }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [playing, setPlaying] = useState(false),
    [position, setPosition] = useState(0),
    [speed, setSpeed] = useState(2),
    [showInput, setShowInput] = useState(false);
  const host = useRef(),
    terminal = useRef(),
    eventsRef = useRef([]),
    cursor = useRef(0),
    timer = useRef();
  useEffect(() => {
    let active = true;
    (async () => {
      let from = 0,
        events = [],
        meta,
        verified = false;
      do {
        const result = await api(`/recordings/${id}?from=${from}&limit=300`);
        if (!active) return;
        events.push(...result.events);
        meta = result.meta;
        verified = result.verified;
        if (!result.hasMore) break;
        if (result.next <= from) throw new Error('录制分页异常');
        from = result.next;
      } while (active);
      if (active) {
        eventsRef.current = events;
        setData({ meta, events, verified });
      }
    })().catch((e) => active && setError(e.message));
    return () => {
      active = false;
      clearTimeout(timer.current);
    };
  }, [id]);
  useEffect(() => {
    if (!data || !host.current) return;
    const term = new XTerminal({
        disableStdin: true,
        convertEol: true,
        fontSize: 12,
        theme: { background: '#0d1510', foreground: '#cfdfc6' },
        scrollback: 30000,
      }),
      fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    terminal.current = term;
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      term.dispose();
      terminal.current = null;
    };
  }, [Boolean(data)]);
  useEffect(() => {
    if (!playing) return;
    const step = () => {
      const events = eventsRef.current,
        idx = cursor.current;
      if (idx >= events.length) {
        setPlaying(false);
        return;
      }
      const current = events[idx];
      if (current.type !== 'input')
        terminal.current?.write(Uint8Array.from(atob(current.data), (c) => c.charCodeAt(0)));
      cursor.current = idx + 1;
      setPosition(idx + 1);
      const delay = Math.max(0, (events[idx + 1]?.t - current.t || 0) / speed);
      timer.current = setTimeout(step, Math.min(delay, 3000));
    };
    step();
    return () => clearTimeout(timer.current);
  }, [playing, speed]);
  function reset() {
    setPlaying(false);
    clearTimeout(timer.current);
    cursor.current = 0;
    setPosition(0);
    terminal.current?.reset();
  }
  const showAll = () => {
    reset();
    for (const e of data.events)
      if (e.type !== 'input')
        terminal.current?.write(Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0)));
    cursor.current = data.events.length;
    setPosition(data.events.length);
  };
  const decode = (data) =>
    new TextDecoder()
      .decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))
      .replace(/[\x00-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  return (
    <Dialog
      title="SSH 会话回放"
      subtitle={
        data
          ? `${data.meta.username} → ${data.meta.server_name} · ${new Date(data.meta.started_at).toLocaleString('zh-CN')}`
          : '正在读取加密录制…'
      }
      onClose={onClose}
      wide
    >
      <div className="recording-body">
        {error ? (
          <div className="form-error">{error}</div>
        ) : !data ? (
          <div className="panel-loading">
            <LoaderCircle className="spin" size={20} />
            正在校验并解密录制…
          </div>
        ) : (
          <>
            <div className="recording-meta">
              <span>{data.verified ? '完整性校验通过' : '录制尚未完成或会话曾中断'}</span>
              <span>
                {(Number(data.meta.byte_count) / 1024).toFixed(1)} KB · {data.events.length} 段
              </span>
            </div>
            <div className="replay-terminal-frame">
              <div className="replay-terminal" ref={host} />
            </div>
            <div className="replay-controls">
              <button className="btn primary" onClick={() => setPlaying(!playing)}>
                {playing ? <Pause size={15} /> : <Play size={15} />} {playing ? '暂停' : '播放'}
              </button>
              <button className="btn secondary" onClick={reset}>
                <RotateCcw size={15} />
                从头
              </button>
              <button className="btn secondary" onClick={showAll}>
                显示全部
              </button>
              <select
                aria-label="回放速度"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                {[1, 2, 4, 8].map((s) => (
                  <option key={s} value={s}>
                    {s} 倍速
                  </option>
                ))}
              </select>
              <small>
                {position} / {data.events.length}
              </small>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={showInput}
                onChange={(e) => setShowInput(e.target.checked)}
              />
              显示原始输入按键（可能含敏感内容）
            </label>
            {showInput && (
              <pre className="input-records">
                {data.events
                  .filter((e) => e.type === 'input')
                  .map((e) => `[${(e.t / 1000).toFixed(2)}s] ${decode(e.data)}`)
                  .join('\n') || '没有输入记录'}
              </pre>
            )}
            <p className="recording-note">
              回放保留终端输出与输入按键。控制字符、编辑器操作及隐藏输入不能可靠还原为独立命令。录制仅管理员可查看，查看动作也会记入审计。
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
export function PasswordDialog({ Dialog, onClose, notify }) {
  const [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Dialog
      title="修改登录密码"
      subtitle="修改后会退出其他登录，并结束你已有的 SSH 会话。"
      onClose={onClose}
    >
      <form
        className="editor-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(
              '/auth/password',
              json('POST', { current_password: current, password: next }),
            );
            notify('登录密码已修改');
            onClose();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-section">
          <label>
            当前密码
            <PasswordInput
              required
              autoComplete="current-password"

              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label>
            新密码
            <PasswordInput
              required
              autoComplete="new-password"
              minLength={10}
              maxLength={128}

              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-footer">
          <button className="btn primary" disabled={busy}>
            <KeyRound size={15} />
            保存新密码
          </button>
        </div>
      </form>
    </Dialog>
  );
}
