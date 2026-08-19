/**
 * Qiita API のレート枠の読み取りと判断。
 *
 * この層は純粋関数だけで構成する（storage も fetch も触らない）。
 * 「どこまで取りに行ってよいか」の判断をテスト可能な形で 1 箇所に集める。
 *
 * 【実測値 2026-08-19】
 *   認証なし: Rate-Limit: 60   (IP 単位)
 *   認証あり: Rate-Limit: 1000
 * ヘッダー名は X-RateLimit-* ではなく Rate-* である点に注意。
 */
import type { ScanMode } from '../types/domain';

export const RATE_LIMIT_ANON = 60;
export const RATE_LIMIT_AUTH = 1000;

/**
 * 枠を使い切る手前で止めるための余白。
 * 0 まで使うと、他の経路（Phase 3 の疎通確認など）が即座に 429 になる。
 */
export const RATE_SAFETY_MARGIN = 5;

export interface RateState {
  limit: number;
  remaining: number;
  /** Unix 秒。ミリ秒ではない */
  resetAt: number | null;
}

function parseIntHeader(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** 応答ヘッダーから枠の状態を読む。必須の 2 つが欠けていれば null */
export function readRateHeaders(headers: Headers): RateState | null {
  const limit = parseIntHeader(headers.get('Rate-Limit'));
  const remaining = parseIntHeader(headers.get('Rate-Remaining'));
  if (limit === null || remaining === null) return null;
  return { limit, remaining, resetAt: parseIntHeader(headers.get('Rate-Reset')) };
}

/**
 * 取得の射程を決める。
 * トークンがあれば著者の過去記事まで辿る（約 120 req）。
 * 無ければトレンド 30 件のみ（約 30 req）に留める。
 */
export function decideMode(hasToken: boolean): ScanMode {
  return hasToken ? 'full' : 'light';
}

/** モードごとの枠の想定値。実際の残量が読めないときのフォールバックに使う */
export function fallbackLimitFor(mode: ScanMode): number {
  return mode === 'full' ? RATE_LIMIT_AUTH : RATE_LIMIT_ANON;
}

/**
 * あと何件リクエストしてよいか。
 * 実際の残量が読めていればそれを、読めなければモードの想定値を使う。
 */
export function availableRequests(state: RateState | null, fallbackLimit: number): number {
  const remaining = state === null ? fallbackLimit : state.remaining;
  return Math.max(0, remaining - RATE_SAFETY_MARGIN);
}
