import { isIP } from 'node:net';
export function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const publicUrl = env.PUBLIC_URL || 'http://127.0.0.1:4317';
  const url = new URL(publicUrl);
  const gatewayHost = env.SSH_PUBLIC_HOST || '127.0.0.1';
  const localHosts = ['127.0.0.1', 'localhost', '::1'];
  if (
    !production &&
    (!localHosts.includes(env.HOST || '127.0.0.1') ||
      !localHosts.includes(env.SSH_BIND_HOST || '127.0.0.1'))
  )
    throw new Error('本地模式只能监听回环地址；公网使用必须启用 production 与 HTTPS');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('禁止关闭 TLS 证书验证');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('PUBLIC_URL 必须只包含协议、域名和可选端口');
  if (env.TRUST_PROXY && (/^\d+$/.test(env.TRUST_PROXY) || env.TRUST_PROXY === 'true'))
    throw new Error('TRUST_PROXY 必须明确指定可信代理 IP/CIDR；禁止按跳数信任代理');
  if (production && (url.protocol !== 'https:' || !env.PUBLIC_URL))
    throw new Error('公网模式必须配置 HTTPS PUBLIC_URL');
  if (!isIP(gatewayHost) && !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(gatewayHost))
    throw new Error('SSH_PUBLIC_HOST 必须是 IP 或域名');
  if (production && ['localhost', '127.0.0.1', '::1'].includes(gatewayHost))
    throw new Error('公网模式必须配置可访问的 SSH_PUBLIC_HOST');
  const port = Number(env.SSH_PUBLIC_PORT || env.BRIDGE_PORT || 4320);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('SSH_PUBLIC_PORT 格式不正确');
  const recordingLimit = Number(env.RECORDING_MAX_BYTES || 33554432);
  if (!Number.isInteger(recordingLimit) || recordingLimit < 1024 || recordingLimit > 134217728)
    throw new Error('RECORDING_MAX_BYTES 必须在 1KB 至 128MB 之间');
  return {
    production,
    publicUrl: url.origin,
    allowedOrigins: production
      ? [url.origin]
      : [url.origin, 'http://127.0.0.1:5173', 'http://localhost:5173', 'http://localhost:4317'],
    host: env.HOST || '127.0.0.1',
    proxy: env.TRUST_PROXY || false,
    bootstrapToken: env.BOOTSTRAP_TOKEN || '',
    gatewayHost,
    gatewayPort: port,
    gatewayBind: env.SSH_BIND_HOST || '127.0.0.1',
    recording: env.RECORD_SESSIONS !== 'false',
    recordingLimit,
    secureCookie: production,
  };
}
