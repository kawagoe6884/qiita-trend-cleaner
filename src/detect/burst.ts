/**
 * バーストスコアと空アカウント指標。
 *
 * この層は純粋関数だけで構成する（storage も fetch も触らない）。
 *
 * 【どちらも補強スコアであって判定条件ではない】
 * クラスタの成立は cluster.ts が決める。ここが返す値はフィルタに使わず、
 * 記録して Phase 6 の一覧に出し、Phase 9 で重みを調整する材料にする。
 * 早い段階で閾値にすると、適合率を測る前にパラメータが 2 つ増える。
 */
import { toEpochMs } from './like-index';
import type { AccountHandle, LikeIndex } from '../types/domain';
import type { ClusterHit } from './cluster';

/**
 * 「投稿直後」とみなす幅。
 *
 * 組織票の signature は「投稿から間もない時間帯にいいねが集中する」こと。
 * 短すぎると通知経由で読んだ正常な読者を拾えず、長すぎると差が出ない。
 * 1 時間を初期値とし、Phase 9 で実データを見て調整する。
 */
export const BURST_WINDOW_MINUTES = 60;

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
 */
export function burstScore(index: LikeIndex, hit: ClusterHit): number {
  const shared = new Set(hit.sharedItemIds);
  const windowMs = BURST_WINDOW_MINUTES * MS_PER_MINUTE;

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
