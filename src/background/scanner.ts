/**
 * スキャンのオーケストレーション。
 *
 * 【入力は「いま画面に出ている 30 件」】
 * content script が表示中の DOM から読んだ TrendItem を受け取る。この層は
 * トレンドを取りに行かない。Atom フィードと /trend は一致率 70% の別集合で
 * （2026-08-20 実測）、フィードを見ているとユーザーが見ている 9 件を
 * 永久にスキャンできなかった。
 *
 * 【モードの違いは取得範囲だけ】
 * ライト: 受け取った記事の likers のみ（約 30 req）
 * フル  : ＋ 著者の過去記事の likers（約 120 req）
 * 判定ロジックは src/detect/ に 1 本だけ置く。ここは配線するだけ。
 *
 * 【レート枠を予測しない】
 * 429 が返るまで走り、返ったら止める（改訂 6）。残量から手前で止める方式は、
 * 余白の見積もりという別の不確実性と、打ち切り状態の全レイヤー伝播を招いていた。
 * 中断した残りは itemId の重複排除により、次にページを開けば自然に拾える。
 *
 * 【直列に実行する理由】
 * Promise.all で 30 本並べると 429 に一気に当たり、どこで止まったかも分からなくなる。
 */
import { logger } from '../lib/logger';
import { RateLimitError } from '../lib/errors';
import { updateBadge } from '../lib/badge';
import { authorsToVisit, recordVisits, pruneVisits } from './author-visits';
import { fetchLikes, fetchUserItems } from '../api/qiita-client';
import { decideMode } from '../api/rate-budget';
import { mergeLikeIndex, purgeLikeIndex, countRecords } from '../detect/like-index';
import { detectCandidates } from '../detect/detector';
import * as storage from '../lib/storage';
import type { RateState } from '../api/rate-budget';
import type { QiitaLike } from '../api/qiita-client';
import type {
  Candidate,
  Settings,
  IsoDateTime,
  LikeIndex,
  ScanMode,
  ScanResult,
  TrendItem,
} from '../types/domain';

/**
 * フルモードで著者 1 人あたり追加取得する過去記事の数。
 * PRD の試算（著者 30 人 / 追加記事 約 60 本）に合わせる。
 */
const MAX_EXTRA_ITEMS_PER_AUTHOR = 2;

/**
 * Rate-Reset ヘッダーが読めなかったときの再開時刻（秒）。
 * 枠は 1 時間単位で回復するため、429 を受けた時刻から 1 時間後を案内する。
 */
const RATE_WINDOW_SECONDS = 3600;

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

/**
 * 蓄積済みインデックスに現れる itemId を集める。
 *
 * リロードのたびに 30 req 使うと、ライトモードの 60 req/h を 2 回で使い切る。
 * いいねが 1 件も無い記事は記録が残らないため毎回取り直すことになるが、
 * トレンドに載る記事でそれは起こりにくく、起きても 1 req で済む。
 */
function collectKnownItemIds(index: LikeIndex): Set<string> {
  const known = new Set<string>();
  for (const entry of Object.values(index)) {
    for (const like of entry.likes) known.add(like.itemId);
  }
  return known;
}

/** スキャン中に持ち回る進捗。関数間では新しいオブジェクトとして受け渡す */
interface ScanProgress {
  rate: RateState | null;
  /** 429 を受けたか。true になったらそれ以上叩かない */
  rateLimited: boolean;
  /** Rate-Reset の値（Unix 秒）。ヘッダーが無ければ null */
  resetAt: number | null;
  likeRecordCount: number;
  scannedItemCount: number;
}

/**
 * 429 を受けたときの進捗。ここで止めるだけで、取得済みの分は捨てない。
 *
 * 【なぜ warn ではなく debug か】
 * ライトモードの枠は 60 req/h、1 スキャンは約 30 req。トレンドページを
 * 2 回開けば届く。**正常な無料プランの挙動**がエラー欄に記録されるのは
 * 設計の失敗であり、429 は想定内の停止信号である（設計上の約束 13）。
 */
function haltOnRateLimit(progress: ScanProgress, error: RateLimitError): ScanProgress {
  logger.debug('rate limited, stopping scan');
  return { ...progress, rateLimited: true, resetAt: error.resetAt };
}

/** 記事 1 件の likers を取得してインデックスに畳む */
async function scanOneItem(
  item: TrendItem,
  token: string | null,
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
      likeRecordCount: progress.likeRecordCount + foldLikes(index, item, response.data),
      scannedItemCount: progress.scannedItemCount + 1,
    };
  } catch (error) {
    if (error instanceof RateLimitError) return haltOnRateLimit(progress, error);
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
    return progress;
  }
}

/** 記事を順に処理する。429 を受けたらそこで止める */
async function scanItems(
  items: TrendItem[],
  token: string | null,
  index: LikeIndex,
  seen: Set<string>,
  initial: ScanProgress,
): Promise<ScanProgress> {
  let progress = initial;
  for (const item of items) {
    if (progress.rateLimited) return progress;
    progress = await scanOneItem(item, token, index, seen, progress);
  }
  return progress;
}

/** 著者 1 人の過去記事を辿る（フルモードのみ） */
async function scanAuthor(
  handle: string,
  token: string | null,
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
    const afterListing: ScanProgress = { ...initial, rate: listing.rate ?? initial.rate };
    return await scanItems(extras, token, index, seen, afterListing);
  } catch (error) {
    if (error instanceof RateLimitError) return haltOnRateLimit(initial, error);
    // scanOneItem と同じ理由で debug。著者 1 人分の欠損は結果を歪めるが、
    // 拡張の不具合ではない
    logger.debug('skip author:', handle, error);
    return initial;
  }
}

/** 著者を順に巡回する */
interface AuthorScanResult {
  progress: ScanProgress;
  /**
   * 実際に辿り終えた著者。**429 で止まった著者は含めない。**
   *
   * 含めると訪問済みとして記録され、AUTHOR_REVISIT_HOURS のあいだ飛ばされる。
   * 枠切れは毎回同じ順序で起きるので、末尾の著者を永久に取りこぼす。
   *
   * 429 以外の失敗（存在しない著者・非公開）は含める。scanAuthor が握りつぶす
   * ので成否は見えないが、毎回叩き直すより 24 時間待つ方が枠に優しい。
   */
  visited: string[];
}

async function scanAuthorHistory(
  handles: string[],
  token: string | null,
  index: LikeIndex,
  seen: Set<string>,
  initial: ScanProgress,
): Promise<AuthorScanResult> {
  let progress = initial;
  const visited: string[] = [];
  for (const handle of handles) {
    if (progress.rateLimited) break;
    progress = await scanAuthor(handle, token, index, seen, progress);
    if (!progress.rateLimited) visited.push(handle);
  }
  return { progress, visited };
}

/**
 * 検出結果をログに出す。Phase 6 の候補一覧 UI ができるまでの唯一の確認手段であり、
 * OQ-12（ライトモードの射程で捕まえられるか）の検証もここで行う。
 *
 * ゼロ件のときも必ず 1 行出す。定期実行を持たない設計では初回スキャン直後の
 * ゼロ件が正常であり、「動いていない」と誤認させないため。
 * 想定内の動作なので info に留める（warn はエラー欄に載る）。
 */
function logCandidates(candidates: Candidate[], settings: Settings): void {
  logger.info(
    'detected',
    candidates.length,
    // N / M という略号は当事者にしか読めない。何を数えているかを書く
    'candidates (accounts>=' + String(settings.minClusterSize),
    'items>=' + String(settings.minSharedItems),
    'within ' + String(settings.lookbackDays) + 'd)',
  );
  for (const candidate of candidates) {
    logger.info(
      '  candidate: author=' + candidate.authorHandle,
      'cluster:',
      candidate.clusterSize,
      'shared:',
      candidate.sharedItemCount,
      'burst:',
      candidate.burstScore.toFixed(2),
      'empty:',
      candidate.emptyAccountRatio.toFixed(2),
    );
  }
}

/**
 * 今回の取得結果を蓄積へ畳み込み、保持期間を過ぎたものを捨て、検出をかける。
 *
 * **上書きではなくマージする。** 1 スキャン分のスナップショットだけでは
 * 「直近 3 日 = トレンドセット 6 回分」の共起を見られない。
 *
 * 429 で止まったときも実行する。既存方針（途中まででも成果は捨てない）に合わせ、
 * 不完全なインデックスでも候補が出るなら出す。次のスキャンで補強される。
 *
 * 【蓄積は保存の直前に読み直す】
 * スキャン開始時のスナップショットを持ち回ってはいけない。1 スキャンは
 * 25 本前後の直列リクエストで数秒かかり、その間に別のスキャンが保存した分を
 * 丸ごと上書きして消す（read-modify-write の lost update）。
 * 読み直しの窓は 1 マイクロタスクに収まる。
 */
async function persistIndexAndDetect(fresh: LikeIndex): Promise<number> {
  const now = new Date();
  const stored = await storage.getLikeIndex();
  const { index: kept, purgedRecords } = purgeLikeIndex(mergeLikeIndex(stored, fresh), now);
  await storage.saveLikeIndex(kept);

  // 訪問記録も同じタイミングで掃除する。記録だけが残ると、保持期間を過ぎて
  // インデックスから消えた著者を「訪問済み」として飛ばし続けることになる
  const visits = await storage.getAuthorVisits();
  const prunedVisits = pruneVisits(visits, kept);
  if (Object.keys(prunedVisits).length !== Object.keys(visits).length) {
    await storage.saveAuthorVisits(prunedVisits);
  }

  logger.info(
    'index merged:',
    'accounts:',
    Object.keys(kept).length,
    'records:',
    countRecords(kept),
    'purged:',
    purgedRecords,
  );

  // 閾値はユーザーが動かせる（ポップアップのスライダー）。既定値を直接使うと、
  // スライダーを動かしても次のスキャンが既定値で candidates を上書きしてしまう
  const settings = await storage.getSettings();
  const candidates = detectCandidates(kept, settings, now);
  await storage.saveCandidates(candidates);
  logCandidates(candidates, settings);
  return candidates.length;
}

/**
 * 429 の状態を記録する。止まっていなければ消す。
 *
 * Rate-Reset が読めなかった場合は「いま + 1 時間」で案内する。枠は 1 時間単位で
 * 回復するため、この既定値は実際の回復より遅くなることはあっても早くはならない。
 */
async function persistRateLimit(progress: ScanProgress): Promise<void> {
  if (!progress.rateLimited) {
    await storage.saveRateLimit(null);
    return;
  }
  const resetAt = progress.resetAt ?? Math.floor(Date.now() / 1000) + RATE_WINDOW_SECONDS;
  await storage.saveRateLimit(resetAt);
  logger.info('rate limited: retry after', new Date(resetAt * 1000).toISOString());
}

interface PersistInput {
  mode: ScanMode;
  progress: ScanProgress;
  startedAt: IsoDateTime;
  fresh: LikeIndex;
  newItemCount: number;
}

async function persistScan(input: PersistInput): Promise<ScanResult> {
  const { mode, progress } = input;
  const result: ScanResult = {
    mode,
    newItemCount: input.newItemCount,
    scannedItemCount: progress.scannedItemCount,
    likeRecordCount: progress.likeRecordCount,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
  };

  const candidateCount = await persistIndexAndDetect(input.fresh);
  await storage.saveScanResult(result);
  await persistRateLimit(progress);
  await updateBadge(candidateCount, progress.rateLimited);

  logger.info(
    'scan finished: mode=' + mode,
    // 直前の 'trend items:' が入力件数なので、ここは取得できた件数だと分かる語にする。
    // 同じ 'items:' を 2 つの意味で使うと、全件既知のときの 'items: 0' が
    // 「何も取れなかった」と読める
    'fetched:',
    progress.scannedItemCount,
    'likes:',
    progress.likeRecordCount,
    'rate-remaining:',
    progress.rate?.remaining ?? 'unknown',
  );
  return result;
}

/**
 * スキャンを 1 回実行する。
 *
 * items は content script が表示中のページから読んだトレンド記事。
 * 既にインデックスにある記事は叩かないため、同じページをリロードしても
 * API を 1 度も消費しない。
 */
/**
 * スキャンが走っている間 true。**同時に 2 本走らせない。**
 *
 * content script は qiita.com のページを開くたびに TREND_ITEMS を送り、
 * service worker は待ち行列を持たずに fire-and-forget で受ける。2 タブ同時や
 * スキャン中のリロードで重なると、同じ記事をもう一度叩いて 60 req/h を
 * 一気に使い切る。取りこぼした分は次にページを開けば拾えるので、
 * 重なった側は黙って捨ててよい（想定内なので debug）。
 *
 * service worker が終了すればフラグごと消えるため、ロックが残ることはない。
 */
let scanning = false;

export async function runScan(items: TrendItem[]): Promise<ScanResult | null> {
  const startedAt = new Date().toISOString();

  if (items.length === 0) {
    // トレンドページ以外では 0 件が正常。エラー欄に載せない
    logger.debug('scan skipped: no trend items');
    return null;
  }
  if (scanning) {
    logger.debug('scan skipped: another scan is in flight');
    return null;
  }
  scanning = true;
  try {
    return await scanTrend(items, startedAt);
  } finally {
    scanning = false;
  }
}

async function scanTrend(items: TrendItem[], startedAt: IsoDateTime): Promise<ScanResult> {
  const token = await storage.getToken();
  const mode = decideMode(token !== null);
  const fresh: LikeIndex = {};
  // 訪問記録の時刻は startedAt に揃える。スキャン中に日付が変わっても、
  // 「このスキャンで辿った」ことを 1 つの時刻で表す
  const now = new Date(startedAt);

  const stored = await storage.getLikeIndex();
  const known = collectKnownItemIds(stored);
  // 過去記事の巡回でも既知の記事は避ける
  const seen = new Set<string>(known);
  const newItems = items.filter((item) => !known.has(item.itemId));

  logger.info('trend items:', items.length, 'new:', newItems.length, 'mode=' + mode);

  let progress: ScanProgress = {
    rate: null,
    rateLimited: false,
    resetAt: null,
    likeRecordCount: 0,
    scannedItemCount: 0,
  };

  progress = await scanItems(newItems, token, fresh, seen, progress);

  // 個々の失敗は debug に留めるため、全滅だけはここで拾う。
  // 30 件中 30 件が落ちるのは通常運転ではなく、API 仕様変更・トークンの全面拒否の
  // いずれか。これは「拡張が壊れている」なので warn でよい。
  // 429 で止まった場合は全滅ではないので除く。
  if (newItems.length > 0 && !progress.rateLimited && progress.scannedItemCount === 0) {
    logger.warn('scan produced no data: all', newItems.length, 'items failed');
  }

  // 著者は **items（トレンド全件）から取る。newItems ではない。**
  //
  // newItems から取っていたせいで、ライトモードで蓄積したあとにトークンを
  // 設定した人は、その著者の過去記事を **永久に** 取りに行かなかった
  // （2026-08-23 の実機で判明）。トレンドの記事が全件既知なら handles が
  // 空になり、著者巡回が 1 度も走らない。
  //
  // 「リロードでは API を 1 度も叩かない」は訪問記録の側で守る。
  // fetchUserItems は seen を見る **前** に呼ばれるので、対象を絞らないと
  // 全件既知でも著者数ぶん（最大 30 req）を消費してしまう。
  if (mode === 'full' && !progress.rateLimited) {
    const visits = await storage.getAuthorVisits();
    const handles = authorsToVisit(
      items.map((item) => item.authorHandle),
      visits,
      now,
    );
    if (handles.length > 0) {
      const history = await scanAuthorHistory(handles, token, fresh, seen, progress);
      progress = history.progress;
      await storage.saveAuthorVisits(recordVisits(visits, history.visited, now));
    }
  }

  return persistScan({ mode, progress, startedAt, fresh, newItemCount: newItems.length });
}
