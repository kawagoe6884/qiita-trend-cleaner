/**
 * 著者をまたぐ共起の判定。
 *
 * この層は純粋関数だけで構成する（storage も fetch も触らない）。
 *
 * 【なぜ cluster.ts では足りないか】
 * cluster.ts は著者ごとに閉じているので、**記事が 1 本しかない著者は手順 1 で
 * 必ず落ちる**。だが実測（2026-08-23）では、同じ 17 人が 2 人の著者の記事に
 * 揃って現れていた。1 人 1 本ずつ投稿して互いに押し合う形は、著者内の判定では
 * 原理的に見えない。閾値をどう動かしても届かない。
 *
 * 【判定は記事ペアの重なりで見る】
 * 「M 本以上いいねした顔ぶれ」を全記事にまたがって数えると、**顔ぶれが違っても
 * 人数だけ揃ってしまう**（記事 X に 5 人、記事 Y に別の 5 人）。ペアの重なりを
 * 直接見れば「同じ人が両方に現れた」ことが保証される。
 *
 * 【成立したペアは連結成分に分ける】
 * 成立したペアを 1 つの集合に貯めると、**独立した 2 つの組織が同時に成立した
 * とき互いの顔ぶれが混ざる**。UI が「同じ顔ぶれが〈重なりゼロの著者〉の記事にも
 * 現れています」と事実でないことを述べ、clusterSize が膨らみ、
 * emptyAccountRatio が無関係なアカウントで希釈される。
 * 著者をノード・成立したペアを辺とするグラフの連結成分ごとに集計する。
 *
 * 【誤検知をどう防ぐか】
 * 実測 528 ペアのうち 50 組に重なりがあり、その大半は 1〜3 人だった
 * （トレンドを見た人がたまたま両方を押した）。重なり 5 以上は 3 組だけで、
 * 3 位と 4 位の差は 15 対 3。**minClusterSize(5) で切れば正常な記事ペアは
 * 1 組も引っかからない。**
 *
 * 【計算量】
 * 記事数の 2 乗 × アカウント数。実測は 33 記事 × 198 アカウントで、
 * 保持期間 7 日でも数百記事に収まる。cluster.ts と同じく最適化しない。
 */
import type { AccountHandle, ItemId, LikeIndex, Settings } from '../types/domain';
import type { ClusterHit } from './cluster';

/** 著者をまたぐ共起で成立した 1 著者ぶん */
export interface CrossClusterHit extends ClusterHit {
  /**
   * 同じ連結成分に属する他の著者。**成分をまたいで混ぜない。**
   * UI はここを見て「他にも居る」ことを示すので、無関係な著者が入ると
   * ユーザーに嘘を伝えることになる。
   */
  coAuthors: AccountHandle[];
}

/** 記事 1 本の観測。著者で分けずに、記事を単位にする */
interface ItemView {
  authorHandle: AccountHandle;
  likers: Set<AccountHandle>;
}

/** 閾値を満たした記事ペア */
interface QualifyingPair {
  authorX: AccountHandle;
  itemX: ItemId;
  authorY: AccountHandle;
  itemY: ItemId;
  overlap: AccountHandle[];
}

/** 連結成分ごとの集計 */
interface Component {
  itemsByAuthor: Map<AccountHandle, Set<ItemId>>;
  accounts: Set<AccountHandle>;
}

/** インデックスを記事ごとの観測に組み替える */
function buildItemViews(index: LikeIndex): [ItemId, ItemView][] {
  const views = new Map<ItemId, ItemView>();

  for (const [account, entry] of Object.entries(index)) {
    for (const record of entry.likes) {
      const view = views.get(record.itemId) ?? {
        authorHandle: record.authorHandle,
        likers: new Set<AccountHandle>(),
      };
      view.likers.add(account);
      views.set(record.itemId, view);
    }
  }

  return [...views];
}

function addItem(
  map: Map<AccountHandle, Set<ItemId>>,
  author: AccountHandle,
  itemId: ItemId,
): void {
  const ids = map.get(author) ?? new Set<ItemId>();
  ids.add(itemId);
  map.set(author, ids);
}

/**
 * Union-Find の根を引く（経路圧縮つき）。
 * **再帰しない。**著者数は数百になりうるので、スタックに頼らない。
 */
function findRoot(parent: Map<AccountHandle, AccountHandle>, handle: AccountHandle): AccountHandle {
  let root = handle;
  for (;;) {
    const next = parent.get(root);
    if (next === undefined || next === root) break;
    root = next;
  }
  let cursor = handle;
  while (cursor !== root) {
    const next = parent.get(cursor) ?? root;
    parent.set(cursor, root);
    cursor = next;
  }
  return root;
}

function union(
  parent: Map<AccountHandle, AccountHandle>,
  a: AccountHandle,
  b: AccountHandle,
): void {
  const rootA = findRoot(parent, a);
  const rootB = findRoot(parent, b);
  if (rootA !== rootB) parent.set(rootA, rootB);
}

/** 閾値を満たしたペアを集め、著者を連結する */
function collectPairs(
  items: [ItemId, ItemView][],
  settings: Settings,
  parent: Map<AccountHandle, AccountHandle>,
): QualifyingPair[] {
  const pairs: QualifyingPair[] = [];

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const left = items[i];
      const right = items[j];
      if (left === undefined || right === undefined) continue;
      const [itemX, x] = left;
      const [itemY, y] = right;

      // 同じ著者の記事は cluster.ts の担当。ここで拾うと二重に検出する
      if (x.authorHandle === y.authorHandle) continue;

      const overlap = [...x.likers].filter((account) => y.likers.has(account));
      if (overlap.length < settings.minClusterSize) continue;

      pairs.push({ authorX: x.authorHandle, itemX, authorY: y.authorHandle, itemY, overlap });
      union(parent, x.authorHandle, y.authorHandle);
    }
  }

  return pairs;
}

/** ペアを連結成分ごとにまとめる */
function groupByComponent(
  pairs: QualifyingPair[],
  parent: Map<AccountHandle, AccountHandle>,
): Component[] {
  const components = new Map<AccountHandle, Component>();

  for (const pair of pairs) {
    // union 済みなので authorX と authorY は同じ根を持つ
    const root = findRoot(parent, pair.authorX);
    const component = components.get(root) ?? {
      itemsByAuthor: new Map<AccountHandle, Set<ItemId>>(),
      accounts: new Set<AccountHandle>(),
    };
    addItem(component.itemsByAuthor, pair.authorX, pair.itemX);
    addItem(component.itemsByAuthor, pair.authorY, pair.itemY);
    for (const account of pair.overlap) component.accounts.add(account);
    components.set(root, component);
  }

  return [...components.values()];
}

/**
 * 別々の著者の記事に、同じ顔ぶれが揃うクラスタを探す。
 *
 * 成立した著者それぞれに CrossClusterHit を返す。**sharedItemIds にはその著者の
 * 記事だけを入れる** — popup-state.ts が根拠 URL を authorHandle から
 * 組み立てるため、他著者の記事 ID を混ぜると誤った記事を表示する。
 * 他の著者は coAuthors に入れる（**同じ連結成分のものだけ**）。
 */
export function findCrossAuthorClusters(index: LikeIndex, settings: Settings): CrossClusterHit[] {
  const parent = new Map<AccountHandle, AccountHandle>();
  const pairs = collectPairs(buildItemViews(index), settings, parent);
  const hits: CrossClusterHit[] = [];

  for (const component of groupByComponent(pairs, parent)) {
    // 著者が 1 人以下なら、著者をまたいでいない
    if (component.itemsByAuthor.size < 2) continue;

    // 記事の総数も条件を満たすこと。**著者ごとには課さない** —
    // 記事 1 本の著者を捕まえるための判定なので、1 人あたり 1 本でよい。
    // **成分ごとに数える** — 別の組織の記事で本数を満たしてはいけない
    const totalItems = [...component.itemsByAuthor.values()].reduce(
      (sum, ids) => sum + ids.size,
      0,
    );
    if (totalItems < settings.minSharedItems) continue;

    const clusterAccounts = [...component.accounts].sort();
    const authors = [...component.itemsByAuthor.keys()];
    for (const [authorHandle, ids] of component.itemsByAuthor) {
      hits.push({
        authorHandle,
        clusterAccounts,
        sharedItemIds: [...ids].sort(),
        coAuthors: authors.filter((other) => other !== authorHandle).sort(),
      });
    }
  }

  return hits.sort((a, b) => a.authorHandle.localeCompare(b.authorHandle));
}
