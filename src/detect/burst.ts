/**
 * バーストスコアと空アカウント指標。
 *
 * この層は純粋関数だけで構成する（storage も fetch も触らない）。
 *
 * 【どちらも補強スコアであって判定条件ではない】
 * クラスタの成立は cluster.ts / cross-cluster.ts が決める。ここが返す値は
 * **フィルタに使わない。**記録して一覧に出し、並び順のタイブレークに使うだけ。
 *
 * Phase 9 で開放したのは **幅（Settings.burstWindowMinutes）だけ**で、
 * 下限は作らなかった。**いつ押すかを握っているのは攻撃側だから。**
 * 下限を設ければ、手口を知った相手は時刻をずらすだけで候補から消え、
 * しかも消えたことはユーザーに見えない。
 *
 * 幅を動かせることの価値は**探索**にある。60 分で 0.00 の著者が 180 分で
 * 1.00 になれば、ユーザーはそこで遅延に気づく。
 *
 * 【emptyAccountRatio は開放しないし、画面にも出さない】
 * ユーザーが目視で見つけた 2 著者の共通 17 人は空率 6%、インデックス全体は
 * 38% だった。**手口を素通りしただけでなく、より健全に見せた**（OQ-15）。
 * 閾値として出すと、善意で上げた人が実在の手口を取りこぼす。
 *
 * **2026-08-25 に表示からも外した。**検出された 31 人の空率 61% に対し、
 * **同じ記事群の liker 全体が 54%**、集団の外側だけでも 50% あった。
 * インデックス全体の 38% と比べれば高いが、その記事群の中では際立たない。
 * OQ-15 と同じ罠（「クラスタの 6%」を「インデックス全体の 38%」と比べた）で、
 * **比較相手を決めない割合は強さを誤って伝える。**
 * 記録は続ける — 同形の基準線（同じ日のトレンド 30 記事の平均など）が
 * 用意できたら戻せる。
 */
import { DEFAULT_SETTINGS } from '../types/domain';
// **rate-budget は純粋モジュール**（storage も fetch も触らない）。
// qiita-client から取ると、そちらをモックしたテストで定数が undefined になる
import { API_PER_PAGE } from '../api/rate-budget';
import { toEpochMs } from './like-index';
import type { AccountHandle, ItemId, LikeIndex, WindowShare } from '../types/domain';
import type { ClusterHit } from './cluster';

/**
 * 「投稿直後」とみなす幅の**既定値**（分）。
 *
 * 組織票の signature は「投稿から間もない時間帯にいいねが集中する」こと。
 * 短すぎると通知経由で読んだ正常な読者を拾えず、長すぎると差が出ない。
 * 1 時間を初期値としていたが、**Phase 9 で幅そのものをユーザーに開放し、
 * 既定を 3 時間（180 分）にした。**1 時間は「通知を見てすぐ読んだ人」と
 * 区別がつきにくく、初期値としては狭すぎた。
 *
 * **DEFAULT_SETTINGS から導出する。**2 箇所に 60 と書くと、片方だけ直す
 * 事故が必ず起きる。domain.ts は detect/ を import しないので循環しない。
 */
export const BURST_WINDOW_MINUTES = DEFAULT_SETTINGS.burstWindowMinutes;

/** 「空アカウント」とみなすフォロワー数の上限 */
export const EMPTY_MAX_FOLLOWERS = 5;

const MS_PER_MINUTE = 60 * 1000;

/**
 * クラスタが揃った記事における、投稿直後のいいねの割合。
 *
 * 分母はクラスタのアカウントが sharedItems に付けたいいねの総数。
 * ただし次は分母からも除く:
 *   - 日時がパースできないレコード（判断材料にならない）
 *   - Δ < 0 のレコード（記事投稿より前のいいねはデータ不整合）
 * これらを分母に残すと、壊れたデータが「バーストではない」として
 * スコアを不当に下げる。
 *
 * `windowMinutes` はユーザーが決める（Settings.burstWindowMinutes）。
 * **既定引数を残すのは、幅を気にしない呼び出し側とテストのため。**
 */
export function burstScore(
  index: LikeIndex,
  hit: ClusterHit,
  windowMinutes: number = BURST_WINDOW_MINUTES,
): number {
  const shared = new Set(hit.sharedItemIds);
  const windowMs = windowMinutes * MS_PER_MINUTE;

  let considered = 0;
  let burst = 0;

  for (const account of hit.clusterAccounts) {
    const entry = index[account];
    if (entry === undefined) continue;

    for (const record of entry.likes) {
      if (!shared.has(record.itemId)) continue;

      const liked = toEpochMs(record.likedAt);
      const posted = toEpochMs(record.itemPostedAt);
      if (liked === null || posted === null) continue;

      const delta = liked - posted;
      if (delta < 0) continue;

      considered += 1;
      if (delta <= windowMs) burst += 1;
    }
  }

  // ゼロ除算を作らない。判断材料が無いことは「バーストではない」に倒す
  return considered === 0 ? 0 : burst / considered;
}

/**
 * 窓内にいいねした人のうち、クラスタが何人いたか。**分母が burstScore と違う。**
 *
 *   burstScore  = クラスタの窓内いいね（件） / **クラスタ**のいいね総数（件）
 *   windowShare = 窓内のクラスタ**アカウント数** / **窓内にいいねした実人数**
 *
 * **単位はアカウント**（2026-08-25 にユーザーの指摘で件数から変更）。
 * (アカウント × 記事) の組で数えると、3 記事とも押した人が 3 回数えられ、
 * 見出しの「N アカウント」と食い違う。3 記事の合計が 1 記事のいいね数を
 * 超えて「オーバーフローしている」と読まれた。
 *
 * 前者は「彼らが早く押したか」、後者は「**早い時間帯を彼らが占めたか**」。
 * 実測（2026-08-25）で 2 人の著者を区別できたのは後者だけだった — どの幅でも
 * 80〜95% の著者に対し、もう 1 人は 180 分で 79% ／ 2 日で 43% まで薄まった。
 * **一般の読者は 12〜24 時間後にまとめて来る。**
 *
 * 【測れないときは null を返す】
 * 分母に**クラスタ外の liker も含める**ので、インデックスがその記事の liker を
 * 全員持っていないと計算できない。`page=1` は降順で「最も新しい 100 件」を返す
 * ため、100 いいねを超える記事では窓内が丸ごと欠ける。**分母が小さいだけで 0 で
 * ないのが最も危険**で、3/3 = 100% と自信満々に出してしまう。`itemTotalLikes`
 * と突き合わせ、1 記事でも足りなければ測定そのものを放棄する。
 *
 * 【窓内に誰も居ないときは null ではない】
 * `{ cluster: 0, total: 0 }` を返す。「測れない」と「測ったら空だった」は別物
 * （Precision.ratio の分母 0 と同じ思想）。表示側が言い分ける。
 */
export function windowShare(
  index: LikeIndex,
  hit: ClusterHit,
  windowMinutes: number = BURST_WINDOW_MINUTES,
): WindowShare | null {
  const shared = new Set(hit.sharedItemIds);
  const cluster = new Set(hit.clusterAccounts);
  const windowMs = windowMinutes * MS_PER_MINUTE;

  /** 記事ごとに、インデックスが実際に持っている liker 数 */
  const held = new Map<ItemId, number>();
  /** 記事ごとの、取得時の総いいね数（Total-Count） */
  const totals = new Map<ItemId, number>();
  /** 記事ごとの、投稿から何分後までを全部持っているか */
  const covered = new Map<ItemId, number>();

  /**
   * 窓内に根拠記事のどれかをいいねしたアカウント。**実人数を数える。**
   *
   * (アカウント × 記事) の組で数えると、3 記事とも押した人が 3 回数えられ、
   * 見出しの「N アカウント」と単位が食い違う（2026-08-25 のユーザー指摘）。
   */
  const inWindow = new Set<AccountHandle>();

  for (const [account, entry] of Object.entries(index)) {
    for (const record of entry.likes) {
      if (!shared.has(record.itemId)) continue;

      held.set(record.itemId, (held.get(record.itemId) ?? 0) + 1);
      if (record.itemTotalLikes !== undefined) {
        // **最大を採る。**再取得でいいねが増えていれば新しい方が正しく、
        // 古い値を採ると「揃っている」と誤判定する
        totals.set(record.itemId, Math.max(totals.get(record.itemId) ?? 0, record.itemTotalLikes));
      }
      if (record.itemCoveredMinutes !== undefined) {
        // 再取得でより広く覆えていれば新しい方が正しい
        covered.set(
          record.itemId,
          Math.max(covered.get(record.itemId) ?? 0, record.itemCoveredMinutes),
        );
      }

      const liked = toEpochMs(record.likedAt);
      const posted = toEpochMs(record.itemPostedAt);
      if (liked === null || posted === null) continue;

      const delta = liked - posted;
      if (delta < 0 || delta > windowMs) continue;

      inWindow.add(account);
    }
  }

  // **1 記事でも取りこぼしていれば測らない。**部分的な分母は過大な占有率を出す
  for (const itemId of shared) {
    // **窓の範囲を覆っていれば、全部持っている必要は無い。**
    // 100 件を超える記事は末尾から遡って取るので、真ん中が欠けたまま
    // 「投稿から N 分後までは全部」という形になる（scanner の collectLikes）
    const reach = covered.get(itemId);
    if (reach !== undefined && windowMinutes <= reach) continue;

    const count = held.get(itemId) ?? 0;
    const known = totals.get(itemId);
    if (known !== undefined) {
      if (count < known) return null;
      continue;
    }
    // Total-Count を記録していない古いレコード（この機能より前に取ったもの）。
    // **per_page が上限なので、それ未満しか無ければ「それが全部だった」。**
    // 記事は再取得しない（scanner の seen）ので、ここで救わないと蓄積済みの
    // 候補は永久に「測れません」のままになる。
    // ちょうど上限のときだけは、切り詰められたのか偶然一致したのか分からない
    if (count >= API_PER_PAGE) return null;
  }

  let clusterCount = 0;
  for (const account of inWindow) if (cluster.has(account)) clusterCount += 1;
  return { cluster: clusterCount, total: inWindow.size };
}

/**
 * クラスタのうち、記事 0 本・プロフィール空・フォロワーが少ないアカウントの割合。
 * 一次証拠では「いいねしているアカウントは記事 0 本・プロフィール空に偏る」
 * という観測がある。
 */
export function emptyAccountRatio(index: LikeIndex, accounts: AccountHandle[]): number {
  if (accounts.length === 0) return 0;

  let empty = 0;
  for (const account of accounts) {
    const entry = index[account];
    if (entry === undefined) continue;
    if (
      entry.itemsCount === 0 &&
      !entry.hasDescription &&
      entry.followersCount <= EMPTY_MAX_FOLLOWERS
    ) {
      empty += 1;
    }
  }

  return empty / accounts.length;
}
