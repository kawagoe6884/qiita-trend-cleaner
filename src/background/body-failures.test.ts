import { describe, it, expect } from 'vitest';
import { BODY_RETRY_HOURS, isRetryDue, pruneFailures, recordFailures } from './body-failures';

const NOW = new Date('2026-08-19T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR_MS).toISOString();
}

describe('isRetryDue', () => {
  it('記録が無ければ取りに行く', () => {
    expect(isRetryDue({}, 'item-a', NOW)).toBe(true);
  });

  it('失敗して間もない記事は取りに行かない', () => {
    expect(isRetryDue({ 'item-a': hoursAgo(1) }, 'item-a', NOW)).toBe(false);
  });

  it('ちょうど BODY_RETRY_HOURS 経ったら取り直す（境界は取り直す側）', () => {
    expect(isRetryDue({ 'item-a': hoursAgo(BODY_RETRY_HOURS) }, 'item-a', NOW)).toBe(true);
  });

  it('時刻が読めない記録は無いものとして扱う', () => {
    expect(isRetryDue({ 'item-a': 'broken' }, 'item-a', NOW)).toBe(true);
  });
});

describe('recordFailures', () => {
  it('失敗した記事に now を記録した新しい記録を返し、元は書き換えない', () => {
    // Arrange
    const failures = { 'item-a': hoursAgo(30) };
    // Act
    const next = recordFailures(failures, ['item-a', 'item-b'], NOW);
    // Assert
    expect(next).toEqual({ 'item-a': NOW.toISOString(), 'item-b': NOW.toISOString() });
    expect(failures).toEqual({ 'item-a': hoursAgo(30) });
  });
});

describe('pruneFailures', () => {
  it('取り直す時期が来た記録と読めない記録を落とす', () => {
    // Arrange
    const failures = {
      fresh: hoursAgo(1),
      due: hoursAgo(BODY_RETRY_HOURS),
      broken: 'broken',
    };
    // Act & Assert
    expect(pruneFailures(failures, NOW)).toEqual({ fresh: hoursAgo(1) });
  });
});
