import { describe, it, expect } from 'vitest';
import { readRateHeaders, decideMode, RATE_LIMIT_ANON, RATE_LIMIT_AUTH } from './rate-budget';

describe('readRateHeaders', () => {
  it('実測どおりの Rate-* ヘッダーを読める', () => {
    // Arrange — 2026-08-19 の実測値
    const headers = new Headers({
      'Rate-Limit': '60',
      'Rate-Remaining': '59',
      'Rate-Reset': '1787104432',
    });
    // Act
    const state = readRateHeaders(headers);
    // Assert
    expect(state).toEqual({ limit: 60, remaining: 59, resetAt: 1787104432 });
  });

  it('Rate-Reset が無くても limit と remaining が読めれば返す', () => {
    const state = readRateHeaders(new Headers({ 'Rate-Limit': '1000', 'Rate-Remaining': '995' }));
    expect(state).toEqual({ limit: 1000, remaining: 995, resetAt: null });
  });

  it('ヘッダーが無ければ null', () => {
    expect(readRateHeaders(new Headers())).toBeNull();
  });

  it('remaining だけ欠けていれば null', () => {
    expect(readRateHeaders(new Headers({ 'Rate-Limit': '60' }))).toBeNull();
  });

  it('数値でない値は null として扱う（空文字を 0 と誤読しない）', () => {
    expect(readRateHeaders(new Headers({ 'Rate-Limit': '', 'Rate-Remaining': '' }))).toBeNull();
    expect(
      readRateHeaders(new Headers({ 'Rate-Limit': 'sixty', 'Rate-Remaining': '10' })),
    ).toBeNull();
  });
});

describe('decideMode', () => {
  it('トークンがあれば full', () => {
    expect(decideMode(true)).toBe('full');
  });

  it('トークンが無ければ light', () => {
    expect(decideMode(false)).toBe('light');
  });
});

/**
 * 枠の実測値。判定には使わないが、options ページがモードの説明文で提示する
 * （token-form.ts）。値が変わったら文言も変わるので、ここで固定しておく。
 */
describe('レート枠の定数', () => {
  it('認証なしは 60 req/h、認証ありは 1000 req/h', () => {
    expect(RATE_LIMIT_ANON).toBe(60);
    expect(RATE_LIMIT_AUTH).toBe(1000);
  });
});
