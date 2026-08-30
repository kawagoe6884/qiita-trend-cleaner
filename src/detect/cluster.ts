/**
 * 共起クラスタの判定。プロダクトの中核。
 *
 * この層は純粋関数だけで構成する（storage も fetch も触らない）。
 *
 * 【判定単位はアカウント群であってアカウント単体ではない】
 * 単一アカウントが同一著者の記事を複数いいねするのは、熱心な読者・同僚・
 * 勉強会仲間の正常な行動である。それだけで著者をミュートすると善良な書き手を
 * 巻き添えにする。一次証拠が怪しいのは「1 人が複数いいねしたから」ではなく
 * 「**十数アカウントが同じ顔ぶれで揃うから**」。
 *
 * 【2 段階で絞る理由】
 * 手順 3（A の記事を M 本以上いいねした人が N 人いる）だけでは、
 * 「別々の 5 人がそれぞれ別の 2 本ずつ」でも成立してしまう。
 * 手順 4 で「**その顔ぶれが N 人そろって同じ記事に現れた**」ことを確認する。
 * ここを省くと誤検知が入り込む。cluster.test.ts の
 * 「手順 3 は通るが手順 4 で落ちる」がその番人。
 *
 * 【計算量】
 * 記事数 × アカウント数。ライトモードで 30 記事 × 約 600 レコードなので
 * 素直な二重ループで足りる。最適化しない。
 */
import type { AccountHandle, ItemId, LikeIndex, Settings } from '../types/domain';

/** 1 著者について成立したクラスタ。Candidate の材料になる */
export interface ClusterHit {
  authorHandle: AccountHandle;
  /** 昇順。表示順とテストを安定させるため */
  clusterAccounts: AccountHandle[];
  /** 昇順。クラスタが N 人そろって現れた記事 */
  sharedItemIds: ItemId[];
}

/** 著者ごとの観測。likers から逆算するため、いいねゼロの記事は現れない */
interface AuthorView {
  /** その著者の記事 -> いいねしたアカウント */
  likersByItem: Map<ItemId, Set<AccountHandle>>;
  /** アカウント -> その著者の記事のうちいいねしたもの */
  itemsByAccount: Map<AccountHandle, Set<ItemId>>;
}

function emptyView(): AuthorView {
  return { likersByItem: new Map(), itemsByAccount: new Map() };
}

/** インデックスを著者ごとの観測に組み替える */
function buildAuthorViews(index: LikeIndex): Map<AccountHandle, AuthorView> {
  const views = new Map<AccountHandle, AuthorView>();

  for (const [account, entry] of Object.entries(index)) {
    for (const record of entry.likes) {
      const view = views.get(record.authorHandle) ?? emptyView();

      const likers = view.likersByItem.get(record.itemId) ?? new Set<AccountHandle>();
      likers.add(account);
      view.likersByItem.set(record.itemId, likers);

      const items = view.itemsByAccount.get(account) ?? new Set<ItemId>();
      items.add(record.itemId);
      view.itemsByAccount.set(account, items);

      views.set(record.authorHandle, view);
    }
  }

  return views;
}

/** 1 著者ぶんの判定。成立しなければ null */
function findClusterFor(
  authorHandle: AccountHandle,
  view: AuthorView,
  settings: Settings,
): ClusterHit | null {
  // 手順 1: その著者の記事が M 本に満たなければ、共起のしようがない
  if (view.likersByItem.size < settings.minSharedItems) return null;

  // 手順 2-3: 「A の記事を M 本以上いいねしている顔ぶれ」
  const qualifying = new Set<AccountHandle>();
  for (const [account, items] of view.itemsByAccount) {
    if (items.size >= settings.minSharedItems) qualifying.add(account);
  }
  if (qualifying.size < settings.minClusterSize) return null;

  // 手順 4: 「その顔ぶれが N 人そろって現れた記事」
  // ここが誤検知との分かれ目。手順 3 だけで候補にしてはいけない
  const sharedItemIds: ItemId[] = [];
  for (const [itemId, likers] of view.likersByItem) {
    const overlap = [...likers].filter((account) => qualifying.has(account));
    if (overlap.length >= settings.minClusterSize) sharedItemIds.push(itemId);
  }
  if (sharedItemIds.length < settings.minSharedItems) return null;

  return {
    authorHandle,
    clusterAccounts: [...qualifying].sort(),
    sharedItemIds: sharedItemIds.sort(),
  };
}

/**
 * 蓄積されたインデックスから共起クラスタを探す。
 *
 * **ScanMode を引数に取らない。** ライトとフルの違いは入力する記事集合だけで、
 * 判定ロジックは 1 本に保つ（CLAUDE.md の設計上の約束 9）。
 */
export function findClusters(index: LikeIndex, settings: Settings): ClusterHit[] {
  const hits: ClusterHit[] = [];
  for (const [authorHandle, view] of buildAuthorViews(index)) {
    const hit = findClusterFor(authorHandle, view, settings);
    if (hit !== null) hits.push(hit);
  }
  return hits;
}
