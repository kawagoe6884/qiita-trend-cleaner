/**
 * 「AI文体かも？」用の本文取得に失敗した記事の記録。
 *
 * この層は純粋関数だけで構成する（storage も fetch も触らない）。
 * author-visits.ts と同じ思想で、「どの記事を取り直してよいか」の判断を
 * テスト可能な形で 1 箇所に集める。
 *
 * 【なぜ記録が要るか】
 * スコア済みの記事は取り直さないが、失敗した記事は未スコアのまま残る。
 * セキュリティソフトが特定の記事の本文を遮断すると取得は毎回失敗し、
 * **トレンドを開くたびに叩き直して、そのたびに遮断の通知が出る**
 * （2026-10-25 の実機で Norton が著者一覧を遮断した件から）。
 * 削除・限定公開の記事も同じで、毎回 1 リクエストを無駄にする。
 *
 * 429 は記録しない。枠が戻れば取れるので、呼び出し側が渡さないこと。
 */
import { toEpochMs } from '../detect/like-index';
import type { AiHintFailures, ItemId } from '../types/domain';

/**
 * 失敗した記事を取り直すまでの間隔。著者の再訪（AUTHOR_REVISIT_HOURS）と
 * 同じ 24 時間にそろえるが、**別の値**。遮断なら 1 日 1 回の通知で済み、
 * 一時的なネット断なら翌日には取れる。
 */
export const BODY_RETRY_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

/** 記録が無い・読めない・BODY_RETRY_HOURS 経った、のいずれかなら true */
export function isRetryDue(failures: AiHintFailures, itemId: ItemId, now: Date): boolean {
  const last = failures[itemId];
  if (last === undefined) return true;
  const failedMs = toEpochMs(last);
  // 読めない記録で永久に飛ばすより、取り直す方が無害
  if (failedMs === null) return true;
  // ちょうど BODY_RETRY_HOURS 経過したら取り直す（境界は取り直す側）
  return failedMs <= now.getTime() - BODY_RETRY_HOURS * MS_PER_HOUR;
}

/** 失敗した記事の時刻を now にした**新しい**記録を返す。渡された記録は書き換えない */
export function recordFailures(
  failures: AiHintFailures,
  itemIds: readonly ItemId[],
  now: Date,
): AiHintFailures {
  const at = now.toISOString();
  const next: AiHintFailures = { ...failures };
  for (const itemId of itemIds) next[itemId] = at;
  return next;
}

/** 取り直す時期が来た記録を落とす。残しても isRetryDue が true を返すだけで、場所を取る */
export function pruneFailures(failures: AiHintFailures, now: Date): AiHintFailures {
  const kept: AiHintFailures = {};
  for (const [itemId, at] of Object.entries(failures)) {
    if (!isRetryDue(failures, itemId, now)) kept[itemId] = at;
  }
  return kept;
}
