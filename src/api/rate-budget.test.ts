import { describe, it, expect } from 'vitest';
import {
  readRateHeaders,
  decideMode,
  fallbackLimitFor,
  availableRequests,
  RATE_LIMIT_ANON,
  RATE_LIMIT_AUTH,
  RATE_SAFETY_MARGIN,
} from './rate-budget';

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

describe('fallbackLimitFor', () => {
  it('light は認証なしの枠', () => {
    expect(fallbackLimitFor('light')).toBe(RATE_LIMIT_ANON);
  });

  it('full は認証ありの枠', () => {
    expect(fallbackLimitFor('full')).toBe(RATE_LIMIT_AUTH);
  });
});

describe('availableRequests', () => {
  it('実測の残量から余白を引く', () => {
    // Arrange
    const state = { limit: 60, remaining: 40, resetAt: null };
    // Act & Assert
    expect(availableRequests(state, RATE_LIMIT_ANON)).toBe(40 - RATE_SAFETY_MARGIN);
  });

  it('残量が読めないときはモードの想定値から引く', () => {
    expect(availableRequests(null, RATE_LIMIT_ANON)).toBe(RATE_LIMIT_ANON - RATE_SAFETY_MARGIN);
  });

  it('残量が余白以下なら 0 を返す（負にしない）', () => {
    expect(availableRequests({ limit: 60, remaining: 3, resetAt: null }, RATE_LIMIT_ANON)).toBe(0);
    expect(availableRequests({ limit: 60, remaining: 0, resetAt: null }, RATE_LIMIT_ANON)).toBe(0);
  });

  it('ライトモードの枠でトレンド 30 件を賄える', () => {
    // Arrange — 60 req/h から余白を引いても 30 件のスキャンは通る
    const available = availableRequests({ limit: 60, remaining: 60, resetAt: null }, RATE_LIMIT_ANON);
    // Assert
    expect(available).toBeGreaterThanOrEqual(30);
  });
});
