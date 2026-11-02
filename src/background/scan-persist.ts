/**
 * スキャンの成果を保存する。**scanner.ts から切り出した**（2026-11-02。800 行の
 * 目安を超えていたため）。取得（API を叩く側）と保存（storage に書く側）の境目で切った。
 *
 * scanner が持ち回る進捗（ScanProgress）は型だけ読む。実行時の循環 import にはならない。
 */
import { logger } from '../lib/logger';
import * as storage from '../lib/storage';
import { pruneVisits } from './author-visits';
import { syncBadge } from './badge-sync';
import { mergeLikeIndex, purgeLikeIndex, countRecords } from '../detect/like-index';
import { detectCandidates } from '../detect/detector';
import type { ScanProgress } from './scanner';
import type {
  Candidate,
  IsoDateTime,
  LikeIndex,
  ScanMode,
  ScanResult,
  Settings,
} from '../types/domain';

/**
 * Rate-Reset ヘッダーが読めなかったときの再開時刻（秒）。
 * 枠は 1 時間単位で回復するため、429 を受けた時刻から 1 時間後を案内する。
 */
const RATE_WINDOW_SECONDS = 3600;

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
async function persistIndexAndDetect(fresh: LikeIndex): Promise<void> {
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

export interface PersistInput {
  mode: ScanMode;
  progress: ScanProgress;
  startedAt: IsoDateTime;
  fresh: LikeIndex;
  newItemCount: number;
}

/**
 * スキャン 1 回分の成果を保存し、バッジを合わせる。
 *
 * バッジの件数は badge-sync が storage から数える（ポップアップの一覧と同じ入力）。
 * このスキャンが受け取ったトレンド記事では数えない — スナップショットの保存に
 * 失敗したとき、バッジだけが数えて一覧には出ない候補ができるため。
 */
export async function persistScan(input: PersistInput): Promise<ScanResult> {
  const { mode, progress } = input;
  const result: ScanResult = {
    mode,
    newItemCount: input.newItemCount,
    scannedItemCount: progress.scannedItemCount,
    likeRecordCount: progress.likeRecordCount,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
  };

  await persistIndexAndDetect(input.fresh);
  await storage.saveScanResult(result);
  await persistRateLimit(progress);
  await syncBadge(progress.rateLimited);

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
