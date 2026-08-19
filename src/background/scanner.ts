/**
 * スキャンのオーケストレーション。
 *
 * 【モードの違いは取得範囲だけ】
 * ライト: トレンド 30 件の likers のみ（約 30 req）
 * フル  : ＋ 著者の過去記事の likers（約 120 req）
 * 判定ロジックは Phase 5 側に 1 本だけ置く。ここで検出は行わない。
 *
 * 【直列に実行する理由】
 * Promise.all で 30 本並べるとレート制限に一気に当たり、
 * Rate-Remaining を見ながらの打ち切り判断も効かなくなる。
 */
import { logger } from '../lib/logger';
import { fetchFeedIfChanged } from '../feed/feed-fetcher';
import { fetchLikes, fetchUserItems } from '../api/qiita-client';
import { decideMode, availableRequests, fallbackLimitFor } from '../api/rate-budget';
import * as storage from '../lib/storage';
import type { RateState } from '../api/rate-budget';
import type { QiitaLike } from '../api/qiita-client';
import type { IsoDateTime, LikeIndex, ScanMode, ScanResult, TrendItem } from '../types/domain';

/**
 * フルモードで著者 1 人あたり追加取得する過去記事の数。
 * PRD の試算（著者 30 人 / 追加記事 約 60 本）に合わせる。
 */
const MAX_EXTRA_ITEMS_PER_AUTHOR = 2;

/**
 * likers をアカウント単位のインデックスに畳む。
 * 引数の index を直接更新する。ローカルで組み立てる作業用オブジェクトであり、
 * 外部に共有された状態を書き換えているわけではない。
 */
function foldLikes(index: LikeIndex, item: TrendItem, likes: QiitaLike[]): number {
  for (const like of likes) {
    const handle = like.user.id;
    // noUncheckedIndexedAccess のため undefined を考慮する
    const entry = index[handle] ?? {
      likes: [],
      itemsCount: like.user.items_count,
      followersCount: like.user.followers_count,
      hasDescription: typeof like.user.description === 'string' && like.user.description !== '',
    };
    entry.likes.push({
      itemId: item.itemId,
      authorHandle: item.authorHandle,
      likedAt: like.created_at,
      itemPostedAt: item.publishedAt,
    });
    index[handle] = entry;
  }
  return likes.length;
}

/** 過去記事を TrendItem 形式に揃える（インデックスの入力形式を 1 つに保つ） */
function toTrendItem(handle: string, itemId: string, createdAt: string): TrendItem {
  return {
    itemId,
    url: `https://qiita.com/${handle}/items/${itemId}`,
    authorHandle: handle,
    publishedAt: createdAt,
  };
}

/** 残り枠を更新する。実測値が読めればそれを、読めなければ 1 減らす */
function nextBudget(current: number, rate: RateState | null, mode: ScanMode): number {
  return rate === null ? Math.max(0, current - 1) : availableRequests(rate, fallbackLimitFor(mode));
}

/** スキャン中に持ち回る進捗。関数間では新しいオブジェクトとして受け渡す */
interface ScanProgress {
  budget: number;
  rate: RateState | null;
  truncated: boolean;
  likeRecordCount: number;
  scannedItemCount: number;
}

/** 記事 1 件の likers を取得してインデックスに畳む */
async function scanOneItem(
  item: TrendItem,
  token: string | null,
  mode: ScanMode,
  index: LikeIndex,
  seen: Set<string>,
  progress: ScanProgress,
): Promise<ScanProgress> {
  try {
    const response = await fetchLikes(item.itemId, token);
    seen.add(item.itemId);
    return {
      ...progress,
      rate: response.rate ?? progress.rate,
      budget: nextBudget(progress.budget, response.rate, mode),
      likeRecordCount: progress.likeRecordCount + foldLikes(index, item, response.data),
      scannedItemCount: progress.scannedItemCount + 1,
    };
  } catch (error) {
    // 1 記事の失敗でスキャン全体を止めない。
    //
    // 【なぜ warn ではなく debug か】
    // Chrome は console.warn も chrome://extensions のエラー欄に集める（2026-08-19 実測）。
    // 記事の削除・限定公開・一時的な 5xx で数件落ちるのは通常運転であり、
    // 失効トークンによる 401 もここへ落ちてくる。qiita-client 側で 401 を debug に
    // 下げても、この catch が warn のままでは同じログが 1 スキャンにつき最大 30 回
    // エラー欄に積まれ、修正が経路ごと素通りする。
    // 全滅したかどうかは runScan の集計（scan produced no data）で拾う。
    logger.debug('skip item:', item.itemId, error);
    return { ...progress, budget: Math.max(0, progress.budget - 1) };
  }
}

/** 記事を順に処理する。枠が尽きたら truncated を立てて打ち切る */
async function scanItems(
  items: TrendItem[],
  token: string | null,
  mode: ScanMode,
  index: LikeIndex,
  seen: Set<string>,
  initial: ScanProgress,
): Promise<ScanProgress> {
  let progress = initial;
  for (const item of items) {
    if (progress.budget <= 0) return { ...progress, truncated: true };
    progress = await scanOneItem(item, token, mode, index, seen, progress);
  }
  return progress;
}

/** 著者 1 人の過去記事を辿る（フルモードのみ） */
async function scanAuthor(
  handle: string,
  token: string | null,
  mode: ScanMode,
  index: LikeIndex,
  seen: Set<string>,
  initial: ScanProgress,
): Promise<ScanProgress> {
  try {
    const listing = await fetchUserItems(handle, token);
    const extras = listing.data
      .filter((entry) => !seen.has(entry.id))
      .slice(0, MAX_EXTRA_ITEMS_PER_AUTHOR)
      .map((entry) => toTrendItem(handle, entry.id, entry.created_at));
    const afterListing: ScanProgress = {
      ...initial,
      rate: listing.rate ?? initial.rate,
      budget: nextBudget(initial.budget, listing.rate, mode),
    };
    return await scanItems(extras, token, mode, index, seen, afterListing);
  } catch (error) {
    // scanOneItem と同じ理由で debug。著者 1 人分の欠損は結果を歪めるが、
    // 拡張の不具合ではない
    logger.debug('skip author:', handle, error);
    return { ...initial, budget: Math.max(0, initial.budget - 1) };
  }
}

/** 著者を順に巡回する */
async function scanAuthorHistory(
  handles: string[],
  token: string | null,
  mode: ScanMode,
  index: LikeIndex,
  seen: Set<string>,
  initial: ScanProgress,
): Promise<ScanProgress> {
  let progress = initial;
  for (const handle of handles) {
    if (progress.budget <= 0) return { ...progress, truncated: true };
    progress = await scanAuthor(handle, token, mode, index, seen, progress);
  }
  return progress;
}

/**
 * 結果を組み立てて保存する。
 *
 * feedUpdated の保存は最後に、かつ**完走したときだけ**行う。
 * 先に保存すると途中失敗を「取得済み」と誤認する。
 * 打ち切り時に保存すると、次回スキャンが <updated> 不変でスキップされ、
 * 欠けたインデックスが次のフィード更新（半日後）まで固定される。
 */
async function persistScan(
  mode: ScanMode,
  progress: ScanProgress,
  startedAt: IsoDateTime,
  index: LikeIndex,
  etag: string | null,
  feedUpdated: IsoDateTime,
): Promise<ScanResult> {
  const result: ScanResult = {
    mode,
    scannedItemCount: progress.scannedItemCount,
    likeRecordCount: progress.likeRecordCount,
    truncated: progress.truncated,
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  await storage.saveLikeIndex(index);
  await storage.saveScanResult(result);
  // 打ち切ったときは「処理済み」にしない。次回スキャンで再試行できるようにする
  if (!progress.truncated) {
    await storage.saveFeedCache(etag, feedUpdated);
  }

  logger.info(
    'scan finished: mode=' + mode,
    'items:',
    progress.scannedItemCount,
    'likes:',
    progress.likeRecordCount,
    'truncated:',
    progress.truncated,
    'rate-remaining:',
    progress.rate?.remaining ?? 'unknown',
  );
  return result;
}

/**
 * スキャンを 1 回実行する。
 * フィードが変わっていなければ API を 1 度も叩かずに null を返す。
 */
export async function runScan(): Promise<ScanResult | null> {
  const startedAt = new Date().toISOString();

  const outcome = await fetchFeedIfChanged();
  if (outcome.kind === 'unchanged') {
    logger.info('scan skipped: feed unchanged');
    return null;
  }

  const token = await storage.getToken();
  const mode = decideMode(token !== null);
  const index: LikeIndex = {};
  const seen = new Set<string>();

  logger.info('scan started: mode=' + mode, 'items:', outcome.snapshot.items.length);

  let progress: ScanProgress = {
    budget: availableRequests(null, fallbackLimitFor(mode)),
    rate: null,
    truncated: false,
    likeRecordCount: 0,
    scannedItemCount: 0,
  };

  progress = await scanItems(outcome.snapshot.items, token, mode, index, seen, progress);

  // 個々の失敗は debug に留めるため、全滅だけはここで拾う。
  // 30 件中 30 件が落ちるのは通常運転ではなく、パーサの破損・API 仕様変更・
  // トークンの全面拒否のいずれか。これは「拡張が壊れている」なので warn でよい。
  const attempted = outcome.snapshot.items.length;
  if (attempted > 0 && !progress.truncated && progress.scannedItemCount === 0) {
    logger.warn('scan produced no data: all', attempted, 'items failed');
  }

  if (mode === 'full' && !progress.truncated) {
    const handles = [...new Set(outcome.snapshot.items.map((item) => item.authorHandle))];
    progress = await scanAuthorHistory(handles, token, mode, index, seen, progress);
  }

  return persistScan(mode, progress, startedAt, index, outcome.etag, outcome.snapshot.feedUpdated);
}
