/**
 * Qiita API v2 クライアント。
 *
 * 【実測 2026-08-19】
 * - likes は認証不要で 200 を返す。トークンの有無で変わるのはレート枠だけ
 * - likes の応答に User が同梱される（items_count / followers_count / description）。
 *   そのため GET /api/v2/users/:user_id を呼ぶ必要は無い
 * - Total-Count ヘッダーでページネーションの要否を 1 リクエスト目で判定できる
 *
 * 【外部データの扱い】
 * content-script.ts の isPongResponse と同じ方針で、レスポンスは型ガードで検証する。
 * JSON.parse の結果を型アサーションで信用しない。
 */
import { QtgError } from '../lib/errors';
import { logger } from '../lib/logger';
import { readRateHeaders } from './rate-budget';
import type { RateState } from './rate-budget';

const API_BASE = 'https://qiita.com/api/v2';
/** Qiita API の上限。101 以上を指定するとエラーになる */
const PER_PAGE = 100;

/**
 * パスセグメントに入れてよい形式。
 *
 * encodeURIComponent は "." をエンコードしないため ".." を防げない。
 * ".." が通ると /users/../items が /api/items に潰れ、別のエンドポイントを叩く。
 * パーサ側でも検証しているが、このクライアントを別経路から呼ばれても壊れないよう
 * ここを最終防衛線にする。
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** 検証を通した値だけをエンコードして返す。違反は呼び出し側のバグなので例外にする */
function toSafeSegment(value: string, context: string): string {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new QtgError(`unsafe path segment (${context})`);
  }
  return encodeURIComponent(value);
}

/** likes / items の応答に含まれる User（使う部分だけ） */
export interface QiitaUser {
  id: string;
  items_count: number;
  followers_count: number;
  description: string | null;
}

/** GET /items/:item_id/likes の 1 要素 */
export interface QiitaLike {
  created_at: string;
  user: QiitaUser;
}

/** GET /users/:user_id/items の 1 要素（使う部分だけ） */
export interface QiitaItem {
  id: string;
  created_at: string;
}

export interface ApiResponse<T> {
  data: T;
  rate: RateState | null;
  /** Total-Count ヘッダー。ページネーション要否の判定に使う */
  totalCount: number | null;
}

function isQiitaUser(value: unknown): value is QiitaUser {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<QiitaUser>;
  return typeof candidate.id === 'string' && candidate.id.length > 0;
}

function isQiitaLike(value: unknown): value is QiitaLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<QiitaLike>;
  return typeof candidate.created_at === 'string' && isQiitaUser(candidate.user);
}

function isQiitaItem(value: unknown): value is QiitaItem {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<QiitaItem>;
  return typeof candidate.id === 'string' && typeof candidate.created_at === 'string';
}

/**
 * 共通のリクエスト処理。
 * トークンがあるときだけ Authorization を付ける。
 * 空文字や "Bearer null" を送ると 401 になるため、null 判定を厳密に行う。
 */
async function request(path: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null && token.length > 0) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { headers });
  } catch (error) {
    throw new QtgError(`api request failed: ${path}`, { cause: error });
  }

  // 401 / 403 はトークンが無効なだけ。想定内の失敗なので warn に留める
  // （logger.error は Chrome の拡張機能エラーバッジを立ててしまう）
  if (response.status === 401 || response.status === 403) {
    logger.warn('api auth rejected:', response.status, path);
    throw new QtgError(`api auth rejected (${String(response.status)})`);
  }
  if (response.status === 429) {
    logger.warn('api rate limit exceeded:', path);
    throw new QtgError('api rate limit exceeded');
  }
  if (!response.ok) {
    throw new QtgError(`api returned status ${String(response.status)}: ${path}`);
  }
  return response;
}

function readTotalCount(headers: Headers): number | null {
  const raw = headers.get('Total-Count');
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

async function readArray<T>(
  response: Response,
  guard: (value: unknown) => value is T,
  context: string,
): Promise<ApiResponse<T[]>> {
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new QtgError(`api returned non-array: ${context}`);
  }
  // 形の合わない要素だけ捨てる。1 件の欠損で取得全体を失敗させない
  const data = body.filter(guard);
  if (data.length !== body.length) {
    logger.warn('api response had unexpected elements:', context, body.length - data.length);
  }
  return { data, rate: readRateHeaders(response.headers), totalCount: readTotalCount(response.headers) };
}

/** 記事のいいね一覧。認証不要（トークンがあればレート枠が広がる） */
export async function fetchLikes(
  itemId: string,
  token: string | null,
): Promise<ApiResponse<QiitaLike[]>> {
  const path = `/items/${toSafeSegment(itemId, 'itemId')}/likes?per_page=${String(PER_PAGE)}`;
  const response = await request(path, token);
  return readArray(response, isQiitaLike, `likes(${itemId})`);
}

/** 著者の記事一覧。フルモードでのみ使う */
export async function fetchUserItems(
  handle: string,
  token: string | null,
): Promise<ApiResponse<QiitaItem[]>> {
  const path = `/users/${toSafeSegment(handle, 'handle')}/items?per_page=${String(PER_PAGE)}`;
  const response = await request(path, token);
  return readArray(response, isQiitaItem, `items(${handle})`);
}

/**
 * トークンの疎通確認。Phase 3 のトークン設定 UI が使う。
 * 実測では有効なトークンで 200 と 18 キーの User が返り、Rate-Limit が 1000 になる。
 */
export async function verifyToken(token: string): Promise<boolean> {
  try {
    await request('/authenticated_user', token);
    return true;
  } catch {
    return false;
  }
}
