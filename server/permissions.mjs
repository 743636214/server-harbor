export const permissionKeys = [
  'server.create',
  'server.edit',
  'server.delete',
  'server.connect',
  'cloud.manage',
];
export const permissionLabels = {
  'server.create': '新增服务器',
  'server.edit': '修改与信任指纹',
  'server.delete': '删除服务器',
  'server.connect': 'SSH 连接与监控',
  'cloud.manage': '安全组管理',
};
export function permissionsFor(user) {
  const raw =
    typeof user.permissions === 'string' ? JSON.parse(user.permissions) : user.permissions || {};
  return Object.fromEntries(
    permissionKeys.map((key) => [key, user.role === 'admin' || raw[key] === true]),
  );
}
export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    active: Boolean(row.active),
    permissions: permissionsFor(row),
    created_at: row.created_at,
    ...(row.login_locked_until !== undefined ? { login_locked_until: row.login_locked_until } : {}),
  };
}
export async function transaction(db, work) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const value = await work(connection);
    await connection.commit();
    return value;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
