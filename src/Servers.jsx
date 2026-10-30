import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  Terminal,
  Activity,
  Cpu,
  MemoryStick,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  Pause,
  Play,
  Power,
  ArrowUpRight,
  LoaderCircle,
} from 'lucide-react';
import { api, json } from './client.mjs';
import '@xterm/xterm/css/xterm.css';
const bytes = (value) => {
  let n = Number(value) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < 4) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
};
function Sparkline({ values, color = '#b8edb5' }) {
  const points = values
    .map(
      (v, i) =>
        `${values.length > 1 ? (i / (values.length - 1)) * 300 : 0},${65 - Math.max(0, Math.min(100, v)) * 0.6}`,
    )
    .join(' ');
  return (
    <svg
      className="sparkline"
      viewBox="0 0 300 72"
      preserveAspectRatio="none"
      aria-label="最近使用率趋势"
    >
      <path d="M0 65H300M0 35H300M0 5H300" fill="none" stroke="#3b5034" strokeWidth=".5" />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
export function MonitorDialog({
  row,
  Dialog,
  onClose,
  onConnect,
  onSecurityGroup,
  canConnect,
  canCloud,
}) {
  const [metrics, setMetrics] = useState(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [paused, setPaused] = useState(false),
    [history, setHistory] = useState([]);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    if (!canConnect) {
      setError('当前账号没有 SSH 连接与监控权限');
      return;
    }
    const read = async () => {
      if (pending.current) return;
      pending.current = true;
      setLoading(true);
      try {
        const data = await api(`/servers/${row.id}/monitor`, json('POST', {}));
        if (active) {
          setMetrics(data);
          setHistory((h) => [...h, data].slice(-60));
          setError('');
        }
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        pending.current = false;
        if (active) setLoading(false);
      }
    };
    read();
    const timer = paused ? null : setInterval(read, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [row.id, paused, canConnect]);
  const diskPeak = metrics?.disks.length ? Math.max(...metrics.disks.map((d) => d.percent)) : 0;
  return (
    <Dialog
      title={row.name}
      subtitle={`${row.username}@${row.host}:${row.port} · 服务器详情`}
      onClose={onClose}
      wide
      className="monitor-dialog"
    >
      <div className="monitor-body">
        <div className="server-detail-actions">
          <button className="btn primary" disabled={!canConnect} onClick={() => onConnect('web')}>
            <Terminal size={15} />
            网页 SSH
          </button>
          <button
            className="btn secondary"
            disabled={!canConnect}
            onClick={() => onConnect('termius')}
          >
            <ArrowUpRight size={15} />
            Termius
          </button>
          {canCloud && (
            <button className="btn secondary" onClick={onSecurityGroup}>
              <ShieldCheck size={15} />
              安全组 / 开放端口
            </button>
          )}
          <button className="text-button monitor-pause" onClick={() => setPaused(!paused)}>
            {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? '继续监控' : '暂停刷新'}
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="monitor-status">
          <span>
            {loading ? <LoaderCircle className="spin" size={13} /> : <Activity size={13} />}{' '}
            {metrics ? metrics.hostname : '正在通过 SSH 获取 Linux 指标…'}
          </span>
          <small>
            {metrics ? new Date(metrics.sampledAt).toLocaleTimeString('zh-CN') : ''} ·{' '}
            {paused ? '已暂停' : '每 5 秒刷新'}
          </small>
        </div>
        <div className="monitor-cards">
          {[
            {
              icon: Cpu,
              label: 'CPU 使用率',
              value: metrics?.cpu,
              info: metrics
                ? `${metrics.cores} 核 · 负载 ${metrics.load.map((v) => v.toFixed(2)).join(' / ')}`
                : '采样中',
              values: history.map((h) => h.cpu),
            },
            {
              icon: MemoryStick,
              label: '内存使用率',
              value: metrics?.memory.percent,
              info: metrics
                ? `${bytes(metrics.memory.used)} / ${bytes(metrics.memory.total)}`
                : '采样中',
              values: history.map((h) => h.memory.percent),
            },
            {
              icon: HardDrive,
              label: '磁盘最高使用率',
              value: metrics ? diskPeak : undefined,
              info: metrics ? `${metrics.disks.length} 个磁盘分区` : '采样中',
              values: history.map((h) => Math.max(0, ...h.disks.map((d) => d.percent))),
            },
          ].map(({ icon: Icon, label, value, info, values }) => (
            <div className="monitor-card" key={label}>
              <label>
                <Icon size={16} />
                {label}
              </label>
              <strong>
                {value === undefined ? '—' : value.toFixed(1)}
                <small>%</small>
              </strong>
              <p>{info}</p>
              <Sparkline values={values} />
            </div>
          ))}
        </div>
        <div className="disk-list">
          <h3>
            <HardDrive size={16} />
            磁盘分区
          </h3>
          {metrics?.disks.map((d, i) => (
            <div className="disk-row" key={d.mount + i}>
              <div>
                <b>{d.mount}</b>
                <small>{d.device}</small>
              </div>
              <div className="disk-usage">
                <div className="usage-track">
                  <span
                    style={{
                      width: Math.min(100, d.percent) + '%',
                      background:
                        d.percent >= 90 ? '#d48f7f' : d.percent >= 75 ? '#d7b875' : '#b8edb5',
                    }}
                  />
                </div>
                <small>
                  已用 {bytes(d.used)} / {bytes(d.total)} · 可用 {bytes(d.available)}
                </small>
              </div>
              <b className="usage-percent">{d.percent}%</b>
            </div>
          ))}
          {!metrics && (
            <p className="monitor-note">
              首版支持 Linux；通过 SSH 读取 /proc 与 df，无需安装监控代理。
            </p>
          )}
        </div>
        <p className="monitor-note">
          CPU 采用两次采样的差值；内存按 MemAvailable 统计，包含可回收缓存。当前趋势保留最近 60
          次采样。
          {metrics
            ? ` 系统运行约 ${Math.floor(metrics.uptime / 86400)} 天 ${Math.floor((metrics.uptime % 86400) / 3600)} 小时。`
            : ''}
        </p>
      </div>
    </Dialog>
  );
}
export function WebTerminalDialog({ connection, Dialog, onClose, onReconnect }) {
  const host = useRef(),
    socket = useRef(),
    terminal = useRef();
  const [status, setStatus] = useState('正在连接…'),
    [ready, setReady] = useState(false);
  useEffect(() => {
    const term = new XTerminal({
        cursorBlink: true,
        convertEol: true,
        fontSize: 14,
        theme: { background: '#0b1410', foreground: '#d1e3c6' },
        scrollback: 10000,
      }),
      fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    terminal.current = term;
    const ws = new WebSocket(
      (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/terminal',
    );
    ws.binaryType = 'arraybuffer';
    socket.current = ws;
    let active = true,
      connected = false;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: 'open',
          token: connection.webToken,
          cols: term.cols,
          rows: term.rows,
        }),
      );
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        term.write(new Uint8Array(event.data));
        return;
      }
      const message = JSON.parse(event.data);
      if (message.type === 'ready') {
        connected = true;
        setReady(true);
        setStatus('已连接');
        term.focus();
      }
      if (message.type === 'error') {
        setStatus(message.message);
        term.writeln('\r\n\x1b[31m' + message.message + '\x1b[0m');
      }
      if (message.type === 'closed') {
        connected = false;
        setReady(false);
        setStatus('会话已结束');
      }
    };
    ws.onclose = () => {
      connected = false;
      if (active) {
        setReady(false);
        setStatus('连接已断开');
        term.writeln('\r\n\x1b[90m[会话已断开]\x1b[0m');
      }
    };
    ws.onerror = () => {
      if (active) setStatus('连接失败，请检查登录状态和网络');
    };
    const input = term.onData((value) => {
      if (!connected || ws.readyState !== 1) return;
      const data = new TextEncoder().encode(value);
      for (let i = 0; i < data.length; i += 32768) ws.send(data.subarray(i, i + 32768));
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current);
    return () => {
      active = false;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      ws.close();
      term.dispose();
    };
  }, [connection.id]);
  return (
    <Dialog
      title={'网页 SSH · ' + connection.row.name}
      subtitle={`${connection.row.username}@${connection.row.host}:${connection.row.port}`}
      onClose={onClose}
      closeOnBackdrop={false}
      closeOnEscape={false}
      wide
      className="terminal-dialog"
    >
      <div className="web-terminal-bar">
        <span className={ready ? 'terminal-connected' : ''}>
          <i />
          {status}
        </span>
        <small>会话输入与输出均会加密录制</small>
        <button className="text-button" onClick={onReconnect}>
          <RefreshCw size={13} />
          重新连接
        </button>
        <button className="text-button" onClick={() => socket.current?.close()}>
          <Power size={13} />
          断开
        </button>
      </div>
      <div className="web-terminal-frame">
        <div className="web-terminal-surface" ref={host} />
      </div>
      <p className="web-terminal-note">
        点击弹窗外不会关闭；右上角关闭会断开连接。Esc / Ctrl+C
        作用于远程终端；会话按账号审计，录制仅管理员可回放。
      </p>
    </Dialog>
  );
}
