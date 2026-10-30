export async function api(path, options = {}) {
  const response = await fetch('/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Server-Harbor': '1', ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || '请求失败');
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}
export const json = (method, body) => ({ method, body: JSON.stringify(body) });
