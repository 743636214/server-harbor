import { transaction } from './permissions.mjs';

export const maximumLoginFailures = 5;
const dayMs = 86400000;
const beijingOffsetMs = 8 * 3600000;
export function beijingDate(now) {
  return new Date(now.getTime() + beijingOffsetMs).toISOString().slice(0, 10);
}
export function nextBeijingMidnight(now) {
  return new Date(
    (Math.floor((now.getTime() + beijingOffsetMs) / dayMs) + 1) * dayMs - beijingOffsetMs,
  );
}

// The database row serializes attempts across requests and app instances.
// Use database UTC time so application timezone settings cannot change expiry.
export async function guardedLogin(
  db,
  { accountKey, check, onSuccess, onFailure, onLock, onUnlock },
) {
  return transaction(db, async (store) => {
    await store.execute(
      'INSERT INTO login_attempts(account_hash) VALUES (?) ON DUPLICATE KEY UPDATE account_hash=account_hash',
      [accountKey],
    );
    const [[state]] = await store.execute(
      "SELECT failed_count,DATE_FORMAT(attempt_day,'%Y-%m-%d') AS attempt_day,locked_until,UTC_TIMESTAMP(3) AS now FROM login_attempts WHERE account_hash=? FOR UPDATE",
      [accountKey],
    );
    const now = new Date(state.now),
      today = beijingDate(now);
    if (state.locked_until && new Date(state.locked_until) > now)
      return { kind: 'locked', lockedUntil: new Date(state.locked_until), now };
    let failures = Number(state.failed_count);
    if (state.attempt_day !== today || state.locked_until) {
      failures = 0;
      if (state.locked_until) await onUnlock?.(store);
    }
    const user = await check(store);
    if (user) {
      await store.execute(
        'UPDATE login_attempts SET failed_count=0,attempt_day=?,locked_until=NULL,updated_at=UTC_TIMESTAMP(3) WHERE account_hash=?',
        [today, accountKey],
      );
      return { kind: 'success', user: await onSuccess(store, user) };
    }
    failures = Math.min(maximumLoginFailures, failures + 1);
    const lockedUntil = failures >= maximumLoginFailures ? nextBeijingMidnight(now) : null;
    await store.execute(
      'UPDATE login_attempts SET failed_count=?,attempt_day=?,locked_until=?,updated_at=UTC_TIMESTAMP(3) WHERE account_hash=?',
      [failures, today, lockedUntil, accountKey],
    );
    await onFailure(store, failures);
    if (lockedUntil) await onLock(store, lockedUntil);
    return lockedUntil
      ? { kind: 'locked', lockedUntil, now, newlyLocked: true }
      : { kind: 'failure', remaining: maximumLoginFailures - failures };
  });
}
