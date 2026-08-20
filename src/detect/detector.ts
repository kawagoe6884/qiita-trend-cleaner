/**
 * 検出エンジンの入口。遡及フィルタ → クラスタ判定 → 補強スコアを束ねる。
 *
 * この層も純粋関数である（storage も fetch も触らない）。
 * storage への保存とログ出力は scanner.ts の責務。
 *
 * 【ScanMode を引数に取らない理由】
 * ライトモードとフルモードで判定ロジックを 2 本持たない（CLAUDE.md の約束 9）。
 * 違いは呼び出し側が渡す index の中身だけにする。ここでモードを見ると、
 * 「ライトのときだけ閾値を緩める」ような分岐が入り込み、適合率 80% という
 * 唯一の指標に対して原因の切り分けができなくなる。
 */
import { withinLookback } from './like-index';
import { findClusters } from './cluster';
import { burstScore, emptyAccountRatio } from './burst';
import type { Candidate, LikeIndex, Settings } from '../types/domain';

/**
 * 蓄積されたインデックスから候補を検出する。
 * 該当が無ければ空配列を返す（null ではない）。
 */
export function detectCandidates(index: LikeIndex, settings: Settings, now: Date): Candidate[] {
  const scoped = withinLookback(index, settings.lookbackDays, now);
  const detectedAt = now.toISOString();

  const candidates = findClusters(scoped, settings).map<Candidate>((hit) => ({
    authorHandle: hit.authorHandle,
    clusterAccounts: hit.clusterAccounts,
    clusterSize: hit.clusterAccounts.length,
    sharedItemIds: hit.sharedItemIds,
    sharedItemCount: hit.sharedItemIds.length,
    burstScore: burstScore(scoped, hit),
    emptyAccountRatio: emptyAccountRatio(scoped, hit.clusterAccounts),
    detectedAt,
  }));

  // 怪しい順に並べる。Phase 6 の一覧はこの順で出す
  return candidates.sort((a, b) => b.clusterSize - a.clusterSize || b.burstScore - a.burstScore);
}
