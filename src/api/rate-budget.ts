/**
 * Qiita API のレート枠の読み取りと判断。
 *
 * この層は純粋関数だけで構成する（storage も fetch も触らない）。
 *
 * 【予測的な予算管理を持たない理由】（改訂 6）
 * 以前は残量から余白を引いて「あと何件叩けるか」を計算し、手前で打ち切っていた。
 * これは余白の見積もりという別の不確実性を持ち込み、打ち切り状態
 * （truncated）を全レイヤーに伝播させる必要があった。
 * 現在は **429 が返るまで走り、返ったら止める**。インデックスは itemId で
 * 重複排除しながら蓄積するので、中断した残りは次にページを開けば自然に拾える。
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
 * 1 リクエストで要求する件数（`per_page`）。Qiita API の上限が 100 で、
 * **101 以上を指定するとエラーになる**（増やして枠を節約する道は無い）。
 *
 * 【なぜ qiita-client ではなくここに置くか】
 * **完全性の判定に使うため** `detect/burst.ts` からも参照する。
 * `qiita-client` は 2 つのテストで `vi.mock` されており、そこから定数を
 * import すると**モック下で undefined になる**（`RateLimitError` を
 * `lib/errors.ts` へ移したのと同じ罠）。このモジュールは純粋で、
 * どこからもモックされていない。
 *
 * 【何を保証するか】
 * 応答が 100 件未満なら、それがその時点の**全部**だった。`Total-Count` を
 * 記録していない古いレコードでも、保持件数が 100 未満なら取りこぼしていない
 * と言い切れる。
 */
export const API_PER_PAGE = 100;

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
