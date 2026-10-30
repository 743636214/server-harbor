import { randomUUID } from 'node:crypto';
export async function writeAudit(
  db,
  { user, server, action, outcome = 'success', ip = '', details = {} },
) {
  await db.execute(
    `INSERT INTO audit_events (id,actor_id,actor_username,server_id,server_name,action,outcome,ip,details) VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      randomUUID(),
      user?.id || null,
      user?.username || 'anonymous',
      server?.id || null,
      server?.name || '',
      action,
      outcome,
      String(ip).slice(0, 64),
      JSON.stringify(details),
    ],
  );
}
export function changes(before, after) {
  const result = {};
  for (const key of [
    'name',
    'host',
    'port',
    'username',
    'auth_type',
    'environment',
    'group_name',
    'tags',
  ]) {
    let old = before?.[key] ?? null;
    if (key === 'tags' && typeof old === 'string') old = JSON.parse(old);
    const value = after[key];
    if (JSON.stringify(old) !== JSON.stringify(value)) result[key] = { from: old, to: value };
  }
  if (before?.notes !== after.notes) result.notesChanged = true;
  if (after.password || after.privateKey || after.passphrase || after.clearPassphrase)
    result.credentialsUpdated = true;
  return result;
}
