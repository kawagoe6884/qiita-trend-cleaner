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
import { findCrossAuthorClusters } from './cross-cluster';
import { burstScore, emptyAccountRatio } from './burst';
import type { ClusterHit } from './cluster';
import type { AccountHandle, Candidate, ItemId, LikeIndex, Settings } from '../types/domain';

/**
 * 同じ著者の複数のクラスタを 1 つにまとめる。
 *
 * **候補は著者ごとに 1 件でなければならない。** FeedbackLog は
 * Record<AccountHandle, Verdict> で評価を著者ごとに持つので、候補が 2 つ
 * 並ぶと同じ著者に 2 回「妥当 / 誤り」を押させることになり、適合率の
 * 分母が壊れる。実測（2026-08-24）では 1 人の著者が著者内・著者間の
 * 両方で成立していた。
 */
function mergeHitsByAuthor(hits: ClusterHit[]): ClusterHit[] {
  const merged = new Map<AccountHandle, { accounts: Set<AccountHandle>; items: Set<ItemId> }>();

  for (const hit of hits) {
    const entry = merged.get(hit.authorHandle) ?? {
      accounts: new Set<AccountHandle>(),
      items: new Set<ItemId>(),
    };
    for (const account of hit.clusterAccounts) entry.accounts.add(account);
    for (const itemId of hit.sharedItemIds) entry.items.add(itemId);
    merged.set(hit.authorHandle, entry);
  }

  return [...merged.entries()].map(([authorHandle, entry]) => ({
    authorHandle,
    clusterAccounts: [...entry.accounts].sort(),
    sharedItemIds: [...entry.items].sort(),
  }));
}

/**
 * 蓄積されたインデックスから候補を検出する。
 * 該当が無ければ空配列を返す（null ではない）。
 */
export function detectCandidates(index: LikeIndex, settings: Settings, now: Date): Candidate[] {
  const scoped = withinLookback(index, settings.lookbackDays, now);
  const detectedAt = now.toISOString();

  // 判定は 2 本。**手口ごとに軸を持つのは、ライト／フルで分けないという
  // 約束 9 とは別の話。**著者内に閉じた判定では、記事 1 本の著者が
  // 原理的に検出できない（2026-08-23 実測）。
  const crossHits = findCrossAuthorClusters(scoped, settings);
  // coAuthors は cross-cluster.ts が **連結成分ごとに** 決める。ここで
  // 全 hit から作り直すと、独立した組織どうしを結び付けてしまう
  const coAuthors = new Map(crossHits.map((hit) => [hit.authorHandle, hit.coAuthors]));
  const hits = mergeHitsByAuthor([...findClusters(scoped, settings), ...crossHits]);

  // burstScore / emptyAccountRatio は **マージ後に 1 度だけ**計算する。
  // 判定ごとに出して平均を取ると分母が変わる
  const candidates = hits.map<Candidate>((hit) => {
    const others = coAuthors.get(hit.authorHandle);
    return {
      authorHandle: hit.authorHandle,
      clusterAccounts: hit.clusterAccounts,
      clusterSize: hit.clusterAccounts.length,
      sharedItemIds: hit.sharedItemIds,
      sharedItemCount: hit.sharedItemIds.length,
      burstScore: burstScore(scoped, hit),
      emptyAccountRatio: emptyAccountRatio(scoped, hit.clusterAccounts),
      detectedAt,
      ...(others !== undefined && others.length > 0 ? { coAuthors: others } : {}),
    };
  });

  // 怪しい順に並べる。Phase 6 の一覧はこの順で出す
  return candidates.sort((a, b) => b.clusterSize - a.clusterSize || b.burstScore - a.burstScore);
}
