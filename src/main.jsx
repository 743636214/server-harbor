import { PasswordInput } from './PasswordInput.jsx';
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Terminal,
  Server,
  Search,
  Plus,
  ArrowUpRight,
  Star,
  ChevronDown,
  X,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  Clock3,
  Settings2,
  LayoutGrid,
  List,
  Pencil,
  Trash2,
  Copy,
  Check,
  LoaderCircle,
  ArrowLeft,
  Activity,
  LogOut,
  Fingerprint,
  AlertTriangle,
  Folder,
  CircleHelp,
  Upload,
  Eye,
  EyeOff,
  Users,
  FileClock,
  Play,
  Cloud,
  ChartNoAxesCombined,
} from 'lucide-react';
import './style.css';
import { MonitorDialog, WebTerminalDialog } from './Servers.jsx';
import { CloudPanel, SecurityGroupDialog } from './Cloud.jsx';
import { api, json } from './client.mjs';
import { UsersPanel, AuditPanel, RecordingDialog, PasswordDialog } from './Panels.jsx';

const envLabels = { production: '生产环境', staging: '预发环境', development: '开发环境' };
const statusLabels = {
  launching: '等待 Termius',
  connected: '会话进行中',
  closed: '会话已结束',
  failed: '连接失败',
};
function IconButton({ label, children, ...props }) {
  return (
    <button className="icon-btn" title={label} aria-label={label} {...props}>
      {children}
    </button>
  );
}
function Badge({ env }) {
  return (
    <span className={'badge ' + env}>
      <i />
      {envLabels[env]}
    </span>
  );
}
function Dialog({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  className = '',
  closeOnBackdrop = true,
  closeOnEscape = true,
}) {
  const ref = useRef();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current.showModal();
    return () => {
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={'dialog ' + (wide ? 'wide ' : '') + className}
      onCancel={(e) => {
        if (closeOnEscape) onClose();
        else e.preventDefault();
      }}
      onClick={(e) => {
        if (closeOnBackdrop && e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <IconButton label="关闭" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      {children}
    </dialog>
  );
}
function App() {
  const [auth, setAuth] = useState(null),
    [error, setError] = useState(''),
    [authBusy, setAuthBusy] = useState(false),
    [loggingOut, setLoggingOut] = useState(false),
    [password, setPassword] = useState(''),
    [loginName, setLoginName] = useState('admin'),
    [setupToken, setSetupToken] = useState('');
  const [servers, setServers] = useState([]),
    [history, setHistory] = useState([]),
    [system, setSystem] = useState(null),
    [page, setPage] = useState('servers'),
    [filter, setFilter] = useState('all');
  const [query, setQuery] = useState(''),
    [env, setEnv] = useState('all'),
    [layout, setLayout] = useState('list'),
    [editor, setEditor] = useState(null),
    [toast, setToast] = useState(null),
    [busy, setBusy] = useState(null),
    [trust, setTrust] = useState(null),
    [deleting, setDeleting] = useState(null),
    [help, setHelp] = useState(false),
    [launch, setLaunch] = useState(null),
    [replay, setReplay] = useState(null),
    [changePassword, setChangePassword] = useState(false),
    [webConnection, setWebConnection] = useState(null),
    [monitor, setMonitor] = useState(null),
    [securityGroup, setSecurityGroup] = useState(null);
  const can = (permission) => auth?.user?.permissions?.[permission] === true;
  const searchRef = useRef();
  const notify = (message, type = 'success') => setToast({ message, type });
  async function refresh() {
    try {
      const [s, h, i, a] = await Promise.all([
        api('/servers'),
        api('/connections'),
        api('/system'),
        api('/auth/status'),
      ]);
      setAuth(a);
      setServers(s);
      setHistory(h);
      setSystem(i);
    } catch (e) {
      if (e.status === 401) setAuth((a) => ({ ...a, authenticated: false }));
      else notify(e.message, 'error');
    }
  }
  useEffect(() => {
    api('/auth/status')
      .then(setAuth)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (auth?.authenticated) {
      refresh();
      const timer = setInterval(refresh, 7000);
      return () => clearInterval(timer);
    }
  }, [auth?.authenticated]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    const f = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await api('/auth/logout', json('POST', {}));
      window.location.replace('/');
    } catch (error) {
      if (error.status === 401) window.location.replace('/');
      else {
        notify('退出失败：' + error.message, 'error');
        setLoggingOut(false);
      }
    }
  }
  async function unlock(e) {
    e.preventDefault();
    setAuthBusy(true);
    setError('');
    try {
      const result = await api(
        auth.initialized ? '/auth/login' : '/auth/setup',
        json('POST', { username: loginName, password, setup_token: setupToken }),
      );
      setPassword('');
      setAuth({ initialized: true, authenticated: true, user: result.user });
    } catch (e) {
      setError(e.message);
    } finally {
      setAuthBusy(false);
    }
  }
  async function connect(row, accepted = false, client = 'termius') {
    setBusy(row.id);
    try {
      if (!row.fingerprint && !accepted) {
        if (!can('server.edit')) {
          notify('首次连接需管理员或有修改权限的成员先验证主机指纹', 'error');
          return;
        }
        const result = await api(`/servers/${row.id}/fingerprint`, json('POST', {}));
        setTrust({ row, ...result, client });
        return;
      }
      const result = await api(`/servers/${row.id}/connect`, json('POST', { client }));
      if (client === 'web') {
        setWebConnection({ ...result, row });
      } else {
        setLaunch({ ...result, row });
        window.location.assign(result.url);
        notify('已请求打开你的 Termius；如未自动打开，请点击弹窗按钮');
      }
      await refresh();
    } catch (e) {
      if ((e.code === 'HOST_KEY_CHANGED' || e.code === 'HOST_KEY_REQUIRED') && can('server.edit')) {
        try {
          const result = await api(`/servers/${row.id}/fingerprint`, json('POST', {}));
          setTrust({ row, ...result, client });
        } catch (err) {
          notify(err.message, 'error');
        }
      } else notify(e.message, 'error');
    } finally {
      setBusy(null);
    }
  }
  async function trustHost() {
    setBusy(trust.row.id);
    try {
      await api(`/servers/${trust.row.id}/trust`, json('POST', { ticket: trust.ticket }));
      const { row, intent, client, fingerprint } = trust;
      setTrust(null);
      if (intent === 'monitor') {
        setMonitor({ ...row, fingerprint });
        setBusy(null);
        await refresh();
      } else await connect(row, true, client || 'termius');
    } catch (e) {
      notify(e.message, 'error');
      setBusy(null);
    }
  }
  async function openMonitor(row) {
    if (!can('server.connect')) {
      if (can('cloud.manage')) setSecurityGroup(row);
      else notify('没有 SSH 连接与监控权限', 'error');
      return;
    }
    if (!row.fingerprint) {
      if (!can('server.edit')) {
        notify('请先联系管理员验证这台服务器的主机指纹', 'error');
        return;
      }
      setBusy(row.id);
      try {
        const result = await api(`/servers/${row.id}/fingerprint`, json('POST', {}));
        setTrust({ row, ...result, intent: 'monitor' });
      } catch (e) {
        notify(e.message, 'error');
      } finally {
        setBusy(null);
      }
      return;
    }
    setMonitor(row);
  }
  async function favorite(row) {
    try {
      await api(`/servers/${row.id}/favorite`, json('PATCH', { favorite: !row.favorite }));
      await refresh();
    } catch (e) {
      notify(e.message, 'error');
    }
  }
  async function copy(row) {
    try {
      const host = row.host.includes(':') ? '[' + row.host + ']' : row.host;
      await navigator.clipboard.writeText(`ssh -p ${row.port} ${row.username}@${host}`);
      notify('SSH 命令已复制');
    } catch {
      notify('浏览器未允许访问剪贴板', 'error');
    }
  }
  const shown = servers.filter(
    (s) =>
      (filter !== 'favorites' || s.favorite) &&
      (filter !== 'keys' || s.auth_type === 'key') &&
      (env === 'all' || s.environment === env) &&
      [s.name, s.host, s.username, s.group_name, ...s.tags]
        .join(' ')
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const keyCount = servers.filter((s) => s.auth_type === 'key').length;
  if (!auth || !auth.authenticated)
    return (
      <div className="unlock-screen">
        <div className="unlock-art">
          <Brand />
          <div className="orbit">
            <span />
            <span />
            <span />
            <div className="orbit-core">
              <Terminal size={44} />
            </div>
            <div className="orbit-node node-one">
              <Server size={23} />
            </div>
            <div className="orbit-node node-two">
              <KeyRound size={23} />
            </div>
            <div className="orbit-node node-three">
              <ShieldCheck size={23} />
            </div>
          </div>
          <div className="unlock-intro">
            <div className="eyebrow">YOUR SERVERS. ONE HARBOR.</div>
            <h1>
              每一次连接，
              <br />
              都有一个安全的起点。
            </h1>
            <p>
              把散落的服务器收进一个工作空间。
              <br />
              保存凭据，打开 Termius，即刻开始。
            </p>
          </div>
          <small>
            TEAM WORKSPACE <span>·</span> ENCRYPTED BY DESIGN
          </small>
        </div>
        <div className="unlock-form">
          <div className="lock-mark">
            <LockKeyhole size={26} />
          </div>
          <div className="eyebrow">SERVER HARBOR</div>
          <h2>{auth?.initialized ? '欢迎回来' : '初始化团队工作空间'}</h2>
          <p>
            {auth?.initialized
              ? '使用你的独立账号登录，按授权管理共同服务器。'
              : '创建首位管理员，后续成员由管理员添加和授权。'}
          </p>
          {auth ? (
            <form onSubmit={unlock}>
              <label>
                登录账号
                <input
                  required
                  autoFocus
                  autoComplete="username"
                  value={loginName}
                  onChange={(e) => setLoginName(e.target.value)}
                  placeholder="例如：admin"
                />
              </label>
              {!auth.initialized && auth.setupTokenRequired && (
                <label>
                  初始化令牌
                  <PasswordInput
                    required

                    autoComplete="off"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    placeholder="由部署者通过秘密管理器提供的初始化令牌"
                  />
                </label>
              )}
              <label>
                登录密码
                <PasswordInput
                  autoComplete={auth.initialized ? 'current-password' : 'new-password'}
                  minLength={auth.initialized ? 1 : 10}
                  maxLength={128}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={auth.initialized ? '输入登录密码' : '至少 10 个字符'}
                />
              </label>
              {auth.initialized && (
                <p className="login-lock-policy">
                  当天连续失败 5 次将锁定账号，北京时间次日 00:00
                  自动解封；登录成功会清零失败次数，管理员可提前解锁。
                </p>
              )}
              {error && <div className="form-error">{error}</div>}
              <button className="btn primary full" disabled={authBusy}>
                {authBusy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <ArrowUpRight size={18} />
                )}{' '}
                {auth.initialized ? '登录工作空间' : '创建并进入'}
              </button>
            </form>
          ) : (
            <p>{error || '正在连接本地服务…'}</p>
          )}
          <div className="privacy-note">
            <ShieldCheck size={15} /> 凭据加密存储 · 独立账号 · 操作可追溯
          </div>
        </div>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">
          <span className="workspace-avatar">G</span>
          <div>
            团队工作空间<small>SHARED INFRASTRUCTURE</small>
          </div>
          <span className="local-indicator" />
        </div>
        <div className="nav-label">工作空间</div>
        <nav>
          <Nav
            icon={Server}
            text="所有服务器"
            count={servers.length}
            active={page === 'servers' && filter === 'all'}
            onClick={() => {
              setPage('servers');
              setFilter('all');
            }}
          />
          <Nav
            icon={Star}
            text="我的收藏"
            count={servers.filter((s) => s.favorite).length}
            active={page === 'servers' && filter === 'favorites'}
            onClick={() => {
              setPage('servers');
              setFilter('favorites');
            }}
          />
          <Nav
            icon={KeyRound}
            text="密钥认证"
            count={keyCount}
            active={page === 'servers' && filter === 'keys'}
            onClick={() => {
              setPage('servers');
              setFilter('keys');
            }}
          />
          <Nav
            icon={Clock3}
            text="连接记录"
            active={page === 'history'}
            onClick={() => setPage('history')}
          />
          <Nav
            icon={FileClock}
            text="操作日志"
            active={page === 'audit'}
            onClick={() => setPage('audit')}
          />
          {can('cloud.manage') && (
            <Nav
              icon={Cloud}
              text="云账号与密钥"
              active={page === 'cloud'}
              onClick={() => setPage('cloud')}
            />
          )}
          {auth.user?.role === 'admin' && (
            <Nav
              icon={Users}
              text="成员与权限"
              active={page === 'users'}
              onClick={() => setPage('users')}
            />
          )}
        </nav>
        <div className="nav-label environment-label">环境</div>
        <nav>
          {Object.entries(envLabels).map(([k, v]) => (
            <button
              key={k}
              className={'nav-item ' + (env === k && page === 'servers' ? 'selected' : '')}
              onClick={() => {
                setPage('servers');
                setEnv(env === k ? 'all' : k);
              }}
            >
              <i className={'env-dot ' + k} />
              <span>{v}</span>
              <small>{servers.filter((s) => s.environment === k).length}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="vault-card">
            <div>
              <ShieldCheck size={18} />
              <span>你的连接，妥善保管</span>
            </div>
            <p>
              密码与私钥使用 AES-256
              <br />
              加密，按账号授权使用。
            </p>
            <span className="vault-state">
              <i /> 加密保护已开启
            </span>
          </div>
          <Nav
            icon={Settings2}
            text="连接设置"
            active={page === 'settings'}
            onClick={() => setPage('settings')}
          />
          <Nav icon={CircleHelp} text="使用指南" onClick={() => setHelp(true)} />
          <button
            className="nav-item logout-button"
            title="退出登录"
            aria-label="退出登录"
            onClick={logout}
            disabled={loggingOut}
          >
            <LogOut size={18} />
            <span>{loggingOut ? '正在退出…' : '退出登录'}</span>
          </button>
          <div className="profile">
            <span className="profile-avatar">G</span>
            <span>
              {auth.user?.display_name || auth.user?.username}
              <small>{auth.user?.role === 'admin' ? '管理员' : '普通成员'}</small>
            </span>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            工作空间 <span className="breadcrumb-slash">/</span>{' '}
            <b>
              {{
                history: '连接记录',
                settings: '连接设置',
                audit: '操作日志',
                users: '成员与权限',
                cloud: '云账号与密钥',
              }[page] || '服务器'}
            </b>
          </span>
          <div className="topbar-right">
            <span className="service-live">
              <i /> 团队服务已连接
            </span>
            <span className="top-divider" />
            <span className="version">v2.0</span>
            <button
              className="account-logout"
              onClick={logout}
              disabled={loggingOut}
              title="退出登录"
            >
              <LogOut size={15} />
              <span>{loggingOut ? '正在退出…' : '退出登录'}</span>
            </button>
          </div>
        </header>
        <div className="main-content">
          {page === 'servers' ? (
            <>
              <div className="page-heading">
                <div className="eyebrow">INFRASTRUCTURE / OVERVIEW</div>
                <div className="title-row">
                  <div>
                    <h1>
                      {filter === 'favorites'
                        ? '我的收藏'
                        : filter === 'keys'
                          ? '密钥认证'
                          : '服务器'}
                      <span className="title-dot">.</span>
                    </h1>
                    <p>所有连接，尽在掌握。选择一台服务器，开始工作。</p>
                  </div>
                  {can('server.create') && (
                    <button className="btn primary" onClick={() => setEditor({})}>
                      <Plus size={17} />
                      添加服务器
                    </button>
                  )}
                </div>
              </div>
              <div className="stats">
                <Stat
                  icon={Server}
                  label="全部服务器"
                  value={servers.length}
                  caption="你的基础设施，一目了然"
                />
                <Stat
                  icon={Activity}
                  label="生产环境"
                  value={servers.filter((s) => s.environment === 'production').length}
                  caption="专注每一个重要服务"
                />
                <Stat
                  icon={KeyRound}
                  label="密钥认证"
                  value={keyCount}
                  caption="使用 SSH 私钥建立连接"
                />
                <Stat
                  icon={Star}
                  label="我的收藏"
                  value={servers.filter((s) => s.favorite).length}
                  caption="常用服务器，触手可及"
                />
              </div>
              <div className="section-heading">
                <div>
                  <h2>
                    服务器列表 <span>{shown.length}</span>
                  </h2>
                  <p>通过 Termius 连接到你的服务器</p>
                </div>
                <div className="view-toggle">
                  <IconButton
                    label="列表视图"
                    className={layout === 'list' ? 'active' : ''}
                    onClick={() => setLayout('list')}
                  >
                    <List size={17} />
                  </IconButton>
                  <IconButton
                    label="卡片视图"
                    className={layout === 'grid' ? 'active' : ''}
                    onClick={() => setLayout('grid')}
                  >
                    <LayoutGrid size={16} />
                  </IconButton>
                </div>
              </div>
              <div className="filterbar">
                <div className="search">
                  <Search size={17} />
                  <input
                    ref={searchRef}
                    placeholder="搜索名称、IP、用户名或标签…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <kbd>⌘ K</kbd>
                </div>
                <div className="select-wrap">
                  <i className="tiny-dot" />
                  <select
                    aria-label="环境筛选"
                    value={env}
                    onChange={(e) => setEnv(e.target.value)}
                  >
                    <option value="all">所有环境</option>
                    {Object.entries(envLabels).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} />
                </div>
                {(query || env !== 'all') && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setEnv('all');
                      setQuery('');
                    }}
                  >
                    清除筛选
                  </button>
                )}
                <span className="results-count">{shown.length} 台服务器</span>
              </div>
              {shown.length ? (
                <div className={layout === 'grid' ? 'server-grid' : 'server-table'}>
                  {layout === 'list' && (
                    <div className="table-head">
                      <span>服务器名称</span>
                      <span>连接信息</span>
                      <span>环境 / 分组</span>
                      <span>认证方式</span>
                      <span>操作</span>
                    </div>
                  )}
                  {shown.map((row) => (
                    <div key={row.id} className="server-row">
                      <div className="server-name">
                        <div className={'server-symbol ' + row.environment}>
                          <Server size={21} />
                        </div>
                        <div>
                          <button
                            className="name-link"
                            title="打开服务器监控"
                            onClick={() => openMonitor(row)}
                          >
                            {row.name}
                          </button>
                          <div className="row-tags">
                            {row.tags.length ? (
                              row.tags.slice(0, 3).map((t) => <span key={t}>{t}</span>)
                            ) : (
                              <small>未设置标签</small>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="connection-info">
                        <code>
                          {row.host}
                          <span>:{row.port}</span>
                        </code>
                        <small>{row.username}</small>
                      </div>
                      <div className="env-info">
                        <Badge env={row.environment} />
                        <small>{row.group_name || '未分组'}</small>
                      </div>
                      <div className="auth-info">
                        {row.auth_type === 'key' ? (
                          <KeyRound size={14} />
                        ) : (
                          <LockKeyhole size={14} />
                        )}{' '}
                        {row.auth_type === 'key' ? 'SSH 密钥' : '密码认证'}
                        <small>{row.fingerprint ? '主机指纹已验证' : '首次连接待验证'}</small>
                      </div>
                      <div className="row-actions">
                        <IconButton
                          label={row.favorite ? '取消收藏' : '收藏服务器'}
                          onClick={() => favorite(row)}
                        >
                          <Star size={16} className={row.favorite ? 'starred' : ''} />
                        </IconButton>
                        <IconButton label="复制 SSH 命令" onClick={() => copy(row)}>
                          <Copy size={15} />
                        </IconButton>
                        <IconButton
                          label={can('server.edit') ? '编辑服务器' : '查看服务器'}
                          onClick={() => setEditor(row)}
                        >
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton
                          label="服务器监控"
                          disabled={busy === row.id}
                          onClick={() => openMonitor(row)}
                        >
                          <ChartNoAxesCombined size={16} />
                        </IconButton>
                        {can('cloud.manage') && (
                          <IconButton
                            label="安全组与开放端口"
                            onClick={() => setSecurityGroup(row)}
                          >
                            <ShieldCheck size={16} />
                          </IconButton>
                        )}
                        <button
                          className="btn connect"
                          disabled={busy === row.id || !can('server.connect')}
                          onClick={() => connect(row, false, 'web')}
                        >
                          <Terminal size={15} />
                          网页 SSH
                        </button>
                        <button
                          className="btn connect termius-button"
                          disabled={busy === row.id || !can('server.connect')}
                          title={can('server.connect') ? '连接到服务器' : '无 SSH 连接权限'}
                          onClick={() => connect(row)}
                        >
                          {busy === row.id ? (
                            <LoaderCircle size={15} className="spin" />
                          ) : (
                            <Terminal size={15} />
                          )}
                          Termius
                          <ArrowUpRight size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-illustration">
                    <div />
                    <Server size={34} />
                    <span>
                      <Plus size={14} />
                    </span>
                  </div>
                  <h3>{servers.length ? '没有匹配的服务器' : '你的下一次连接，从这里开始'}</h3>
                  <p>
                    {servers.length
                      ? '尝试其他关键词，或清除当前筛选。'
                      : '添加你的第一台服务器，安全保存 SSH 信息。'}
                  </p>
                  {(servers.length > 0 || can('server.create')) && (
                    <button
                      className="btn secondary"
                      onClick={() =>
                        servers.length
                          ? (setQuery(''), setEnv('all'), setFilter('all'))
                          : setEditor({})
                      }
                    >
                      {servers.length ? (
                        '清除筛选'
                      ) : (
                        <>
                          <Plus size={16} />
                          添加第一台服务器
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}
              <div className="connection-hint">
                <div className="hint-icon">
                  <Terminal size={18} />
                </div>
                <div>
                  <b>从浏览器，直达终端。</b>
                  <p>
                    网页 SSH 可直接在浏览器操作，Termius 按钮打开本机客户端，经 SSH
                    网关接入。会话输入和输出会被加密录制，仅管理员可回放。
                  </p>
                </div>
                <button className="text-button" onClick={() => setHelp(true)}>
                  了解连接方式 <ArrowUpRight size={14} />
                </button>
              </div>
            </>
          ) : page === 'history' ? (
            <>
              <PageHeading
                eyebrow="ACTIVITY / SESSIONS"
                title="连接记录"
                description="查看最近 100 次连接、操作账号与会话录制。"
              />
              <div className="history-list">
                {history.length ? (
                  history.map((h) => (
                    <div className="history-row" key={h.id}>
                      <div className="history-icon">
                        <Terminal size={19} />
                      </div>
                      <div>
                        <b>{h.server_name}</b>
                        <small>
                          {h.username || '旧版账号'} · {h.message || '通过 SSH 网关连接'}
                        </small>
                        {auth.user?.role === 'admin' && h.recording_state && (
                          <button className="text-button" onClick={() => setReplay(h.id)}>
                            <Play size={13} />
                            回放会话 ·{' '}
                            {h.recording_state === 'complete'
                              ? '已完成'
                              : h.recording_state === 'recording'
                                ? '录制中'
                                : '中断 / 异常'}
                          </button>
                        )}
                      </div>
                      <span className={'session-state ' + h.status}>
                        <i />
                        {statusLabels[h.status] || h.status}
                      </span>
                      <time>{new Date(h.created_at).toLocaleString('zh-CN')}</time>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">
                    <Clock3 size={34} />
                    <h3>还没有连接记录</h3>
                    <p>连接服务器后，会话记录会出现在这里。</p>
                  </div>
                )}
              </div>
            </>
          ) : page === 'cloud' && can('cloud.manage') ? (
            <CloudPanel Dialog={Dialog} user={auth.user} notify={notify} />
          ) : page === 'audit' ? (
            <AuditPanel Dialog={Dialog} user={auth.user} />
          ) : page === 'users' && auth.user?.role === 'admin' ? (
            <UsersPanel Dialog={Dialog} notify={notify} />
          ) : (
            <>
              <PageHeading
                eyebrow="WORKSPACE / SETTINGS"
                title="连接设置"
                description="当前工作空间的连接方式与存储状态。"
              />
              <div className="settings-card">
                <h2>
                  <ShieldCheck size={21} /> 团队工作空间
                </h2>
                {[
                  ['数据库', system?.database],
                  ['凭据与录制加密', system?.encryption],
                  ['终端客户端', '每位成员自己电脑上的 Termius'],
                  ['SSH 网关地址', system?.gateway],
                  ['部署模式', system?.deployment],
                  ['会话录制', system?.recording ? '记录输入和输出 · 仅管理员回放' : '未开启'],
                  ['登录有效期', '8 小时 · 权限变更和停用立即撤销登录与连接'],
                ].map(([k, v]) => (
                  <div className="setting-row" key={k}>
                    <span>{k}</span>
                    <b>{v || '读取中…'}</b>
                  </div>
                ))}
                <button
                  className="btn secondary password-settings-button"
                  onClick={() => setChangePassword(true)}
                >
                  <KeyRound size={15} />
                  修改我的登录密码
                </button>
                <p className="setting-note">
                  主密钥保存在项目的 .env 中。迁移或备份时，请同时保存 .env、.data 与 MySQL
                  数据库，并妥善保护这些文件。
                </p>
              </div>
            </>
          )}
          <footer>
            <span>
              <ShieldCheck size={13} /> 按账号授权 · 操作留痕
            </span>
            <span>
              SERVER HARBOR <span className="footer-line">/</span> 为每一次连接，留一处港湾。
            </span>
          </footer>
        </div>
      </main>
      {editor && (
        <ServerEditor
          initial={editor}
          canEdit={editor.id ? can('server.edit') : can('server.create')}
          canDelete={can('server.delete')}
          onClose={() => setEditor(null)}
          onSave={async (data) => {
            try {
              await api(
                '/servers' + (editor.id ? '/' + editor.id : ''),
                json(editor.id ? 'PUT' : 'POST', data),
              );
              setEditor(null);
              notify(editor.id ? '服务器已更新' : '服务器已添加');
              await refresh();
            } catch (e) {
              if (e.status === 401) setAuth((a) => ({ ...a, authenticated: false }));
              throw e;
            }
          }}
          onDelete={() => {
            setDeleting(editor);
            setEditor(null);
          }}
        />
      )}
      {trust && (
        <Dialog
          title={trust.changed ? 'SSH 主机指纹发生变化' : '核对服务器身份'}
          subtitle={trust.row.username + '@' + trust.row.host + ':' + trust.row.port}
          onClose={() => setTrust(null)}
        >
          <div className={'trust-content ' + (trust.changed ? 'warning' : '')}>
            <Fingerprint size={34} />
            <p>
              {trust.changed
                ? '这台服务器的主机密钥与之前不同。请先通过可信渠道核实是否重装系统或更换主机密钥，确认后再继续。'
                : '这是首次连接。请通过服务器控制台或管理员核对以下 SSH 主机指纹，确认连接的是你的服务器。'}
            </p>
            {trust.previous && (
              <>
                <label>之前保存的指纹</label>
                <code>{trust.previous}</code>
              </>
            )}
            <label>当前服务器指纹</label>
            <code>{trust.fingerprint}</code>
            <p className="muted">
              验证命令：<code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>
              。请核对与当前服务端协商的密钥类型对应的指纹。
            </p>
          </div>
          <div className="dialog-footer">
            <button className="btn secondary" onClick={() => setTrust(null)}>
              取消
            </button>
            <button className="btn primary" onClick={trustHost} disabled={Boolean(busy)}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{' '}
              已核实，信任并连接
            </button>
          </div>
        </Dialog>
      )}
      {deleting && (
        <Dialog title="删除这台服务器？" onClose={() => setDeleting(null)}>
          <p className="dialog-copy">
            将移除「{deleting.name}」以及保存在这里的 SSH 凭据。历史连接记录仍会保留。
          </p>
          <div className="dialog-footer">
            <button className="btn secondary" onClick={() => setDeleting(null)}>
              取消
            </button>
            <button
              className="btn danger"
              disabled={busy === deleting.id}
              onClick={async () => {
                setBusy(deleting.id);
                try {
                  await api('/servers/' + deleting.id, json('DELETE', {}));
                  setDeleting(null);
                  notify('服务器已删除');
                  await refresh();
                } catch (e) {
                  notify(e.message, 'error');
                } finally {
                  setBusy(null);
                }
              }}
            >
              确认删除
            </button>
          </div>
        </Dialog>
      )}
      {help && (
        <Dialog
          title="一键连接，如何工作"
          subtitle="共用服务器库，独立账号，按权限连接与管理。"
          onClose={() => setHelp(false)}
        >
          <div className="guide">
            <div>
              <span>01</span>
              <section>
                <h3>添加服务器</h3>
                <p>
                  填写名称、主机、SSH 端口与用户名，选择密码或私钥认证。私钥可直接选择文件导入。
                </p>
              </section>
            </div>
            <div>
              <span>02</span>
              <section>
                <h3>验证主机指纹</h3>
                <p>首次连接核对远程主机指纹。指纹改变时会停止连接，等待你重新核实。</p>
              </section>
            </div>
            <div>
              <span>03</span>
              <section>
                <h3>打开 Termius 开始工作</h3>
                <p>
                  Node.js 使用加密保存的凭据登录远程 SSH。浏览器通过连接链接启动你自己电脑上的
                  Termius，经公网 SSH 网关接入。首次连接请核对网关指纹。
                </p>
              </section>
            </div>
            <div className="guide-note">
              Termius 显示原服务器名称与真实账号，连接地址为团队 SSH
              网关；临时用户名包含一次性票据，90
              秒后失效。会话输入和输出会被录制，仅管理员可回放，查看动作也会记入日志。新增、修改、删除需要管理员授权。
            </div>
          </div>
        </Dialog>
      )}
      {monitor && (
        <MonitorDialog
          row={monitor}
          Dialog={Dialog}
          onClose={() => setMonitor(null)}
          canConnect={can('server.connect')}
          canCloud={can('cloud.manage')}
          onConnect={(client) => connect(monitor, false, client)}
          onSecurityGroup={() => {
            setSecurityGroup(monitor);
            setMonitor(null);
          }}
        />
      )}
      {webConnection && (
        <WebTerminalDialog
          connection={webConnection}
          Dialog={Dialog}
          onClose={() => setWebConnection(null)}
          onReconnect={() => connect(webConnection.row, true, 'web')}
        />
      )}
      {securityGroup && (
        <SecurityGroupDialog
          row={securityGroup}
          Dialog={Dialog}
          onClose={() => setSecurityGroup(null)}
          onManageCredentials={() => {
            setSecurityGroup(null);
            setPage('cloud');
          }}
        />
      )}
      {launch && (
        <Dialog
          title="在你的电脑上打开 Termius"
          subtitle={launch.row.name + ' · ' + launch.row.username + '@' + launch.row.host}
          onClose={() => setLaunch(null)}
        >
          <div className="launch-content">
            <p>Termius 提示验证网关主机密钥时，必须与下方指纹一致；不一致时取消连接。</p>
            <code style={{ display: 'block', overflowWrap: 'anywhere', margin: '12px 0' }}>
              {launch.gatewayFingerprint}
            </code>
            <Terminal size={32} />
            <p>
              连接已准备好。如果浏览器没有自动打开 Termius，请点击下方按钮。链接只能使用一次，90
              秒后失效。
            </p>
            <p className="recording-notice">
              此会话将记录终端输入与输出，内容可能包含敏感信息。只有管理员可查看录制。
            </p>
            <a className="btn primary" href={launch.url}>
              打开我的 Termius <ArrowUpRight size={16} />
            </a>
            <small>关闭终端会断开会话。不要分享连接链接。</small>
          </div>
        </Dialog>
      )}
      {replay && <RecordingDialog id={replay} Dialog={Dialog} onClose={() => setReplay(null)} />}
      {changePassword && (
        <PasswordDialog Dialog={Dialog} notify={notify} onClose={() => setChangePassword(false)} />
      )}
      {toast && (
        <div role="status" className={'toast ' + toast.type}>
          {toast.type === 'error' ? <AlertTriangle size={17} /> : <Check size={17} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span>
        <Terminal size={23} strokeWidth={2.5} />
      </span>
      <div>
        Server Harbor<small>你的服务器工作空间</small>
      </div>
    </div>
  );
}
function Nav({ icon: Icon, text, count, active, onClick }) {
  return (
    <button
      className={'nav-item ' + (active ? 'selected' : '')}
      onClick={onClick}
      aria-label={text}
      title={text}
    >
      <Icon size={17} />
      <span>{text}</span>
      {count !== undefined && <small>{count}</small>}
    </button>
  );
}
function Stat({ icon: Icon, label, value, caption }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {label}
        <Icon size={17} />
      </div>
      <div className="stat-value">
        {String(value).padStart(2, '0')}
        <span>台</span>
      </div>
      <p>{caption}</p>
    </div>
  );
}
function PageHeading({ eyebrow, title, description }) {
  return (
    <div className="page-heading">
      <div className="eyebrow">{eyebrow}</div>
      <h1>
        {title}
        <span className="title-dot">.</span>
      </h1>
      <p>{description}</p>
    </div>
  );
}
function ServerEditor({ initial, onClose, onSave, onDelete, canEdit, canDelete }) {
  const [data, setData] = useState({
      name: '',
      host: '',
      port: 22,
      username: 'root',
      auth_type: 'password',
      environment: 'production',
      group_name: '',
      notes: '',
      favorite: false,
      ...initial,
      password: '',
      privateKey: '',
      passphrase: '',
      tags: (initial.tags || []).join(', '),
    }),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false),
    [visible, setVisible] = useState(false);
  const change = (field, value) => setData((d) => ({ ...d, [field]: value }));
  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await onSave({
        ...data,
        tags: [
          ...new Set(
            data.tags
              .split(/[,，]/)
              .map((t) => t.trim())
              .filter(Boolean),
          ),
        ],
        port: Number(data.port),
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      title={initial.id ? (canEdit ? '编辑服务器' : '查看服务器') : '添加服务器'}
      subtitle="把连接信息留在这里，专注于下一步工作。"
      wide
      onClose={onClose}
    >
      <form onSubmit={(e) => (canEdit ? submit(e) : e.preventDefault())} className="editor-form">
        {!canEdit && (
          <p className="readonly-notice">你可以查看服务器信息。修改或删除需要管理员授权。</p>
        )}
        <fieldset disabled={!canEdit} className="editor-fields">
          <div className="form-section">
            <h3>
              <Server size={16} />
              基本信息
            </h3>
            <label>
              服务器名称 <em>*</em>
              <input
                autoFocus
                required
                maxLength={100}
                value={data.name}
                onChange={(e) => change('name', e.target.value)}
                placeholder="例如：杭州 · 生产服务器"
              />
            </label>
            <div className="form-grid host-grid">
              <label>
                IP 地址 / 主机名 <em>*</em>
                <input
                  required
                  value={data.host}
                  onChange={(e) => change('host', e.target.value)}
                  placeholder="192.168.1.10 或 example.com"
                />
              </label>
              <label>
                SSH 端口 <em>*</em>
                <input
                  required
                  type="number"
                  min="1"
                  max="65535"
                  value={data.port}
                  onChange={(e) => change('port', e.target.value)}
                />
              </label>
            </div>
            <div className="form-grid">
              <label>
                所属环境
                <select
                  value={data.environment}
                  onChange={(e) => change('environment', e.target.value)}
                >
                  {Object.entries(envLabels).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                分组
                <input
                  maxLength={64}
                  value={data.group_name}
                  onChange={(e) => change('group_name', e.target.value)}
                  placeholder="例如：阿里云 / 自建机房"
                />
              </label>
            </div>
          </div>
          <div className="form-section">
            <h3>
              <KeyRound size={16} />
              SSH 身份认证{' '}
              <span>
                <ShieldCheck size={12} />
                加密保存
              </span>
            </h3>
            <label>
              用户名 <em>*</em>
              <input
                required
                maxLength={64}
                value={data.username}
                autoComplete="off"
                onChange={(e) => change('username', e.target.value)}
                placeholder="root"
              />
            </label>
            <div className="auth-switch">
              <button
                type="button"
                className={data.auth_type === 'password' ? 'selected' : ''}
                onClick={() => change('auth_type', 'password')}
              >
                <LockKeyhole size={16} />
                密码认证
              </button>
              <button
                type="button"
                className={data.auth_type === 'key' ? 'selected' : ''}
                onClick={() => change('auth_type', 'key')}
              >
                <KeyRound size={16} />
                SSH 私钥
              </button>
            </div>
            {data.auth_type === 'password' ? (
              <label>
                SSH 密码 {(!initial.id || initial.auth_type !== data.auth_type) && <em>*</em>}
                <div className="password-field">
                  <input
                    type={visible ? 'text' : 'password'}
                    required={!initial.id || initial.auth_type !== data.auth_type}
                    maxLength={4096}
                    autoComplete="new-password"
                    value={data.password}
                    onChange={(e) => change('password', e.target.value)}
                    placeholder={
                      initial.id && initial.auth_type === data.auth_type
                        ? '留空保留已保存的密码'
                        : '输入 SSH 登录密码'
                    }
                  />
                  <button
                    type="button"
                    onClick={() => setVisible(!visible)}
                    aria-label={visible ? '隐藏密码' : '显示密码'}
                  >
                    {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
            ) : (
              <>
                <label>
                  私钥内容{' '}
                  <div className="file-upload">
                    <Upload size={13} />
                    选择私钥文件
                    <input
                      type="file"
                      aria-label="导入 SSH 私钥文件"
                      onChange={async (e) => {
                        const file = e.target.files[0];
                        if (file) {
                          if (file.size > 65536) {
                            setError('私钥文件不能超过 64KB');
                            return;
                          }
                          change('privateKey', await file.text());
                        }
                      }}
                    />
                  </div>
                  <textarea
                    className="key-input"
                    required={!initial.id || initial.auth_type !== data.auth_type}
                    value={data.privateKey}
                    onChange={(e) => change('privateKey', e.target.value)}
                    placeholder={
                      initial.id && initial.auth_type === data.auth_type
                        ? '留空保留已保存的私钥'
                        : '-----BEGIN OPENSSH PRIVATE KEY-----'
                    }
                    rows={5}
                  />
                </label>
                <label>
                  私钥口令（可选）
                  <PasswordInput
                    autoComplete="new-password"
                    value={data.passphrase}
                    onChange={(e) => change('passphrase', e.target.value)}
                    placeholder="如果私钥加密，请填写对应口令"
                  />
                </label>
                {initial.id && initial.auth_type === 'key' && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={data.clearPassphrase || false}
                      onChange={(e) => change('clearPassphrase', e.target.checked)}
                    />
                    清除原来保存的私钥口令
                  </label>
                )}
              </>
            )}
          </div>
          <div className="form-section">
            <h3>
              <Folder size={16} />
              整理与备注
            </h3>
            <label>
              标签
              <input
                value={data.tags}
                onChange={(e) => change('tags', e.target.value)}
                placeholder="用逗号分隔，例如：Docker, MySQL, API"
              />
            </label>
            <label>
              备注
              <textarea
                rows={2}
                maxLength={4000}
                value={data.notes}
                onChange={(e) => change('notes', e.target.value)}
                placeholder="服务用途、配置说明，或想留给自己的提示…"
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={data.favorite}
                onChange={(e) => change('favorite', e.target.checked)}
              />
              收藏这台服务器
            </label>
          </div>
        </fieldset>
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-footer">
          {initial.id && canDelete && (
            <button type="button" className="delete-link" onClick={onDelete}>
              <Trash2 size={15} />
              删除服务器
            </button>
          )}
          <div className="footer-spacer" />
          <button type="button" className="btn secondary" onClick={onClose}>
            取消
          </button>
          {canEdit && (
            <button className="btn primary" disabled={saving}>
              {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{' '}
              {saving ? '保存中…' : '保存服务器'}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
createRoot(document.getElementById('root')).render(<App />);
