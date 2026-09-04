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
import { decideMode, API_PER_PAGE } from '../api/rate-budget';
import {
  mergeLikeIndex,
  purgeLikeIndex,
  countRecords,
  isWithinRetention,
  toEpochMs,
} from '../detect/like-index';
import { MAX_BURST_WINDOW_MINUTES } from '../types/domain';
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
function foldLikes(
  index: LikeIndex,
  item: TrendItem,
  likes: QiitaLike[],
  totalCount: number | null,
  coveredMinutes: number | null,
): number {
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
      // **窓内占有率の分母が信用できるかの判定材料。**
      // ヘッダーが欠けたらフィールドごと付けず「不明」に倒す
      // （exactOptionalPropertyTypes のため undefined 代入はできない）
      ...(totalCount === null ? {} : { itemTotalLikes: totalCount }),
      // 「投稿から何分後までのいいねを全部持っているか」。**1 ページに収まった
      // ときも入る**（値は取得時点の経過分）。取得の瞬間より先のいいねは
      // まだ存在しないので、「その時点の全部」と「窓を覆った」は別物になる。
      // 付けないのは、投稿時刻が読めない / 未来 / 覆った範囲を主張できないときだけ
      ...(coveredMinutes === null ? {} : { itemCoveredMinutes: coveredMinutes }),
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
 * 429 を受けたときの進捗。ここで止めるだけで、**畳み終えた記事**は捨てない。
 *
 * 「取得済みの分」ではなく「畳み終えた記事」と書くのは、**取得中の記事 1 件は
 * 捨てるから**（理由は scanOneItem の catch を見ること）。1 記事が最大 5
 * リクエストになった以上、この 2 つは同じではない。
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

/**
 * 末尾から遡るページ数の上限。
 *
 * ライトモードの枠は 60 req/h で 1 スキャン約 30 req。1 記事に無制限に使うと
 * 他の記事が取れなくなる。**打ち切ったことは coveredMinutes に現れる**ので、
 * 狭い範囲を黙って「完全」と報告することはない。
 */
const MAX_TAIL_PAGES = 4;

const MS_PER_MINUTE = 60 * 1000;

/**
 * そのページで**最も新しいいいね**の、投稿からの経過（分）。求まらなければ null。
 *
 * **`likes[0]` を使わない。**降順であることは実測（2026-08-25）だが、
 * **順序が変わればエラーにならずに違う値を返す。**打ち切りの判断がここに
 * 乗っているので、「失敗したら null」（設計上の約束 3）が効かない壊れ方になる。
 * 最大値を取れば並び順に依存しない — 降順なら結果は同じで、依存が 1 つ減る。
 */
function newestDeltaMinutes(likes: QiitaLike[], postedMs: number): number | null {
  let newest: number | null = null;
  for (const like of likes) {
    const liked = toEpochMs(like.created_at);
    if (liked === null) continue;
    const delta = Math.round((liked - postedMs) / MS_PER_MINUTE);
    if (newest === null || delta > newest) newest = delta;
  }
  return newest;
}

/**
 * 投稿から now までの経過（分）。求まらなければ null。
 *
 * **負なら null に倒す。**記事の投稿時刻が未来になるのは時計のずれかデータの
 * 破損で、そこから「何分ぶん覆っている」とは言えない。こちらはテストで
 * 固定してある（未来の投稿時刻で覆った範囲を書かない）。
 *
 * **パースできない側（postedMs === null）は runScan からは観測できない。**
 * purgeLikeIndex が itemPostedAt を読めないレコードを保存の直前に必ず落とすので、
 * ここで null を返しても 0 を返しても storage の中身は変わらない
 * （変異テストで確認済み）。null にしてあるのは負の場合と揃えた防御であって、
 * テストに守られてはいない。
 *
 * **投稿時刻はパース済みの値で受け取る。**呼び出し側が既に `toEpochMs` して
 * いるので、文字列から取り直すと同じ値を 2 回パースすることになり、
 * **両者の null 性が「たまたま一致している」だけ**になる。
 */
function ageMinutes(postedMs: number | null, now: Date): number | null {
  if (postedMs === null) return null;
  const delta = Math.round((now.getTime() - postedMs) / MS_PER_MINUTE);
  return delta < 0 ? null : delta;
}

interface CollectedLikes {
  likes: QiitaLike[];
  rate: RateState | null;
  totalCount: number | null;
  /**
   * 投稿から何分後までのいいねを全部持っているか。**求まらなければ null。**
   *
   * **1 ページに収まったときも入れる**（値は取得時点の経過分）。likes は
   * 取得した瞬間までのものしか存在しないので、「その時点の全部を持っている」ことと
   * 「窓を覆っている」ことは別物である。投稿 20 分後に取った記事は、
   * 全部持っていても 180 分の窓を覆えていない。
   *
   * ここを「全部持っているなら null」にしていたせいで、windowShare が
   * **窓が経過する前に取った記事を「測れた」として扱っていた**（2026-08-30 実測。
   * 窓を 60 分から 2 日まで動かしても同じ 3/5 と burst 1.00 を返した）。
   */
  coveredMinutes: number | null;
}

/**
 * 記事 1 件の likes を、**投稿直後を含む形で**集める。
 *
 * 【なぜ 1 ページで足りないのか】
 * likes は降順（新しい順）で返るので `page=1` は「最も新しい 100 件」。
 * 100 件を超える記事では**投稿直後のいいねが 1 件も入らない**（2026-08-25 実測:
 * 642 いいねの記事で 180 分以内が 0/100 件、最終ページには 5/42 件）。
 * `burstScore` も窓内占有率もそこにしか意味が無く、**エラーは 1 行も出ない。**
 *
 * 最終ページから遡り、**そのページで最も新しいいいねが
 * `MAX_BURST_WINDOW_MINUTES` を超えたら打ち切る。**ユーザーが選びうる最大の窓を
 * 覆えば、それ以上は判定に使われない。並びが単調降順であることは実測済み。
 *
 * **100 件以下なら今までと同じ 1 リクエストで完全。**追加コストは大きい記事だけ。
 */
async function collectLikes(
  item: TrendItem,
  token: string | null,
  now: Date,
): Promise<CollectedLikes> {
  const first = await fetchLikes(item.itemId, token);
  const total = first.totalCount;
  const postedMs = toEpochMs(item.publishedAt);
  const lastPage = total === null ? 1 : Math.ceil(total / API_PER_PAGE);
  // 全部持っていたときに覆えている範囲。**取得の瞬間より先は存在しない**
  const age = ageMinutes(postedMs, now);

  // 1 ページに収まった / 総数が不明 / 投稿時刻が読めない → 遡らない。
  // **投稿時刻が無いと打ち切りの判断ができず、枠だけ使って終わる**
  if (lastPage <= 1 || postedMs === null) {
    // **page=1 だけで「取得時点の全部」と言えるか。**
    //
    // `Total-Count` が読めれば `lastPage <= 1` がそのまま全部を意味する。
    // 読めないと lastPage は 1 に潰れるので、**応答の件数で見るしかない。**
    // ちょうど上限のときは切り詰められたのか偶然一致かが分からない
    // （windowShare の古い経路とまったく同じ判断）。
    //
    // ここを見ずに age を付けると、**page=1 は「最も新しい 100 件」なので
    // 窓内（投稿直後）が丸ごと欠けている記事を「覆っている」と主張する。**
    // ヘッダーが欠けるのは想定内で、エラーは 1 行も出ない。
    const pageOneIsAll = total !== null || first.data.length < API_PER_PAGE;
    return {
      likes: first.data,
      rate: first.rate,
      totalCount: total,
      coveredMinutes: pageOneIsAll ? age : null,
    };
  }

  // ページ境界は取得中に増えたいいねでずれる。**user.id で重複排除する**
  const byUser = new Map<string, QiitaLike>();
  for (const like of first.data) byUser.set(like.user.id, like);

  let rate = first.rate;
  let covered: number | null = null;
  let complete = false;

  for (let i = 0; i < MAX_TAIL_PAGES; i += 1) {
    const page = lastPage - i;
    const res = await fetchLikes(item.itemId, token, page);
    rate = res.rate ?? rate;
    for (const like of res.data) byUser.set(like.user.id, like);

    if (page <= 2) {
      // 2 ページ目まで遡った = page=1 と合わせて全部持っている。
      //
      // **取った時点で立てる。**「次の周回で page < 2 を見る」形にすると、
      // 上限ちょうどで足りたとき（lastPage=5）に周回が先に尽きて立たない。
      // また delta の判定より前に置く — 最終ページで
      // `delta > MAX_BURST_WINDOW_MINUTES` を踏んでも、全部持っている事実は変わらない。
      complete = true;
      break;
    }

    const delta = newestDeltaMinutes(res.data, postedMs);
    // 時刻が読めなければ判断材料が無い。**進めても覆った範囲を主張できない**
    if (delta === null) break;
    covered = delta;
    if (delta > MAX_BURST_WINDOW_MINUTES) break;
  }

  if (!complete && (covered === null || covered <= MAX_BURST_WINDOW_MINUTES)) {
    // 上限まで遡っても最大の窓を覆えなかった。**黙って切らない**（想定内なので debug）
    logger.debug('like pages truncated:', item.itemId, 'covered minutes:', covered);
  }

  return {
    likes: [...byUser.values()],
    rate,
    totalCount: total,
    // 全ページ揃ったなら覆っているのは「取得の瞬間まで」。それより先は存在しない。
    // 打ち切ったなら、最後に取ったページで最も新しいいいねまで
    coveredMinutes: complete ? age : covered,
  };
}

/** 記事 1 件の likers を取得してインデックスに畳む */
async function scanOneItem(
  item: TrendItem,
  token: string | null,
  index: LikeIndex,
  seen: Set<string>,
  progress: ScanProgress,
  now: Date,
): Promise<ScanProgress> {
  try {
    const response = await collectLikes(item, token, now);
    seen.add(item.itemId);
    return {
      ...progress,
      rate: response.rate ?? progress.rate,
      likeRecordCount:
        progress.likeRecordCount +
        foldLikes(index, item, response.likes, response.totalCount, response.coveredMinutes),
      scannedItemCount: progress.scannedItemCount + 1,
    };
  } catch (error) {
    // 【途中ページで 429 を踏んだら、その記事の page=1 も捨てる】意図的な選択。
    // 部分データを保存すると itemCoveredMinutes が「そこまで覆った」と言えず、
    // 覆っていない範囲を覆ったことにするか、覆った範囲を過少に言うかの二択になる。
    // seen に入れないので次回まるごと取り直せばよく、**損は 1 記事ぶんの
    // 1 リクエストだけ**。この分岐は必ず scanItems のループを止めるので、
    // 同じスキャン内で 2 件以上が無駄になることはない。
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
  now: Date,
): Promise<ScanProgress> {
  let progress = initial;
  for (const item of items) {
    if (progress.rateLimited) return progress;
    progress = await scanOneItem(item, token, index, seen, progress, now);
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
  now: Date,
): Promise<ScanProgress> {
  try {
    const listing = await fetchUserItems(handle, token);
    const extras = listing.data
      .filter((entry) => !seen.has(entry.id))
      // 保持期間より古い記事は取っても purge で消える。**slice より前に絞る。**
      // 逆にすると新しい 2 本を取ってからフィルタし、結果が 0 本になりうる
      .filter((entry) => isWithinRetention(entry.created_at, now))
      .slice(0, MAX_EXTRA_ITEMS_PER_AUTHOR)
      .map((entry) => toTrendItem(handle, entry.id, entry.created_at));
    const afterListing: ScanProgress = { ...initial, rate: listing.rate ?? initial.rate };
    return await scanItems(extras, token, index, seen, afterListing, now);
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
  now: Date,
): Promise<AuthorScanResult> {
  let progress = initial;
  const visited: string[] = [];
  for (const handle of handles) {
    if (progress.rateLimited) break;
    progress = await scanAuthor(handle, token, index, seen, progress, now);
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

/**
 * スキャンを 1 回実行する。
 *
 * items は content script が表示中のページから読んだトレンド記事。
 * 既にインデックスにある記事は叩かないため、同じページをリロードしても
 * API を 1 度も消費しない。
 */
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

  progress = await scanItems(newItems, token, fresh, seen, progress, now);

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
      const history = await scanAuthorHistory(handles, token, fresh, seen, progress, now);
      progress = history.progress;
      await storage.saveAuthorVisits(recordVisits(visits, history.visited, now));
    }
  }

  return persistScan({ mode, progress, startedAt, fresh, newItemCount: newItems.length });
}
