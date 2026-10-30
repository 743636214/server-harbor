import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beijingDate, nextBeijingMidnight } from '../server/login-security.mjs';

test('解封按北京时间自然日边界计算，不是固定等待 24 小时', () => {
  assert.equal(beijingDate(new Date('2026-10-29T15:59:59.999Z')), '2026-10-29');
  assert.equal(
    nextBeijingMidnight(new Date('2026-10-29T15:59:59.999Z')).toISOString(),
    '2026-10-29T16:00:00.000Z',
  );
  assert.equal(beijingDate(new Date('2026-10-29T16:00:00.000Z')), '2026-10-30');
  assert.equal(
    nextBeijingMidnight(new Date('2026-10-29T16:00:00.000Z')).toISOString(),
    '2026-10-30T16:00:00.000Z',
  );
});

test('跨月、跨年和闰年仍在北京时间次日零点解封', () => {
  for (const [start, expected] of [
    ['2026-12-31T12:00:00Z', '2026-12-31T16:00:00.000Z'],
    ['2028-02-28T12:00:00Z', '2028-02-28T16:00:00.000Z'],
    ['2028-02-29T16:00:00Z', '2028-03-01T16:00:00.000Z'],
  ])
    assert.equal(nextBeijingMidnight(new Date(start)).toISOString(), expected);
});
