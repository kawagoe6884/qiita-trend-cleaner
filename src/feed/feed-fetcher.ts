/**
 * Atom フィードの取得と「変わったかどうか」の判定。
 *
 * 二段構えで判定する:
 *   1. conditional GET (If-None-Match) — 304 ならボディすら来ない
 *   2. ルートの <updated> の比較 — ETag が変わっても本文の微修正で
 *      <updated> が動かないことがあるため
 *
 * PRD の設計意図は「<updated> の変化検知」であり、ETag は転送量削減の手段。
 */
import { logger } from '../lib/logger';
import { QtgError } from '../lib/errors';
import { parseFeed } from './atom-parser';
import * as storage from '../lib/storage';
import type { FeedSnapshot } from '../types/domain';

/** 公式フィード。API ではないのでレート枠の対象外 */
export const FEED_URL = 'https://qiita.com/popular-items/feed';

export type FeedFetchOutcome =
  | { kind: 'unchanged' }
  | { kind: 'updated'; snapshot: FeedSnapshot; etag: string | null };

export async function fetchFeedIfChanged(): Promise<FeedFetchOutcome> {
  const cache = await storage.getFeedCache();

  const headers: Record<string, string> = {};
  // ETag は W/"..." の weak 形式。引用符ごとそのまま送る（加工しない）
  if (cache.etag !== null) headers['If-None-Match'] = cache.etag;

  let response: Response;
  try {
    response = await fetch(FEED_URL, { headers });
  } catch (error) {
    throw new QtgError('feed fetch failed', { cause: error });
  }

  // 304 のボディは 0 バイト。text() を読んでもパースしてはいけない
  if (response.status === 304) {
    logger.debug('feed not modified (304)');
    return { kind: 'unchanged' };
  }
  if (!response.ok) {
    throw new QtgError(`feed fetch returned status ${String(response.status)}`);
  }

  const snapshot = parseFeed(await response.text());
  if (snapshot === null) {
    throw new QtgError('feed parse failed');
  }

  if (cache.lastUpdated !== null && snapshot.feedUpdated === cache.lastUpdated) {
    logger.debug('feed updated unchanged:', snapshot.feedUpdated);
    return { kind: 'unchanged' };
  }

  logger.info('feed updated:', snapshot.feedUpdated, 'items:', snapshot.items.length);
  return { kind: 'updated', snapshot, etag: response.headers.get('ETag') };
}
