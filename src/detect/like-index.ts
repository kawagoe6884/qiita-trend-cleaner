/**
 * 逆引きインデックスの蓄積・パージ・遡及フィルタ。
 *
 * この層は純粋関数だけで構成する（storage も fetch も触らない）。
 * rate-budget.ts と同じ思想で、「どのレコードを判定に使ってよいか」の
 * 判断をテスト可能な形で 1 箇所に集める。
 *
 * 【なぜ蓄積が要るか】
 * ライトモードは 1 回のスキャンでは原理的に発火しない。
 * トレンド 30 件の中に同一著者の記事が 2 本入ることが稀で、M=2 を満たせないため。
 * PRD はこれを「直近 3 日 = トレンドセット 6 回分」の蓄積で解いている。
 *
 * 【now を引数で受け取る理由】
 * 関数内で new Date() を呼ぶとテストが実行時刻に依存して壊れる。
 * 呼び出し側が時刻を決め、この層は受け取った時刻だけを見る。
 */
import type { AccountIndexEntry, IsoDateTime, LikeIndex, LikeRecord } from '../types/domain';

/**
 * storage に残す期間。
 *
 * PRD の法務上の判断（利用規約第 11 条 5 項 1 号との距離を取るため、
 * ローカル完結・外部送信なし・保持期間 7 日・共有配布なし）に由来する。
 *
 * 判定に使う遡及窓（Settings.lookbackDays）と **同値でよい**。
 * 避けるのは逆転（lookback > RETENTION）だけで、判定に入らないレコードを
 * 保存し続けることになるため。改訂 6 以降はフルモードを主軸にするので、
 * 既定は同値（7 日）に置く。
 */
export const RETENTION_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * ISO 8601 文字列を epoch ミリ秒にする。パースできなければ null。
 *
 * new Date(...).getTime() は不正な文字列で NaN を返し、**NaN との比較は
 * すべて false になる**。そのままだと「範囲外」と「壊れている」が
 * 区別なく落ちるため、ここで null に正規化して呼び出し側に明示させる。
 */
export function toEpochMs(iso: IsoDateTime): number | null {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** アカウントのメタデータだけを取り出す（likes を持ち回らないため） */
function metaOf(entry: AccountIndexEntry): Omit<AccountIndexEntry, 'likes'> {
  return {
    itemsCount: entry.itemsCount,
    followersCount: entry.followersCount,
    hasDescription: entry.hasDescription,
  };
}

/**
 * 1 アカウント分の likes をマージする。
 *
 * 重複キーは itemId。同じアカウントが同じ記事に 2 回いいねすることはないため、
 * itemId の重複は「前回のスキャンでも同じ記事を見た」を意味する。
 * 新しい方（fresh）で置き換える。
 */
function mergeLikes(stored: LikeRecord[], fresh: LikeRecord[]): LikeRecord[] {
  const byItem = new Map<string, LikeRecord>();
  for (const record of stored) byItem.set(record.itemId, record);
  for (const record of fresh) byItem.set(record.itemId, record);
  return [...byItem.values()];
}

/**
 * 蓄積済みのインデックスに今回のスキャン結果を畳み込む。
 *
 * **引数を破壊しない。** scanner が渡す fresh はローカルの作業用オブジェクトだが、
 * stored は storage から読んだ値であり、書き換えると呼び出し側の想定を壊す。
 */
export function mergeLikeIndex(stored: LikeIndex, fresh: LikeIndex): LikeIndex {
  const merged: LikeIndex = {};

  for (const [handle, entry] of Object.entries(stored)) {
    merged[handle] = { ...metaOf(entry), likes: [...entry.likes] };
  }

  for (const [handle, entry] of Object.entries(fresh)) {
    const existing = merged[handle];
    merged[handle] = {
      // メタデータは新しい方で上書きする。アカウントは成長するため
      ...metaOf(entry),
      likes: existing === undefined ? [...entry.likes] : mergeLikes(existing.likes, entry.likes),
    };
  }

  return merged;
}

/**
 * 記事の投稿時刻が cutoff 以降のレコードだけを残した新しいインデックスを返す。
 * パースできない日時のレコードも落とす（残しても判定に使えないため）。
 * likes が空になったアカウントはエントリごと落とす。
 */
function filterByCutoff(index: LikeIndex, cutoffMs: number): { index: LikeIndex; dropped: number } {
  const kept: LikeIndex = {};
  let dropped = 0;

  for (const [handle, entry] of Object.entries(index)) {
    const likes = entry.likes.filter((record) => {
      const posted = toEpochMs(record.itemPostedAt);
      if (posted === null || posted < cutoffMs) {
        dropped += 1;
        return false;
      }
      return true;
    });
    if (likes.length > 0) kept[handle] = { ...metaOf(entry), likes };
  }

  return { index: kept, dropped };
}

/**
 * 保持期間を過ぎたレコードを捨てる。storage に書く直前に呼ぶ。
 * 基準は itemPostedAt（記事の投稿時刻）。PRD の「直近 N 日の記事」に合わせる。
 */
export function purgeLikeIndex(
  index: LikeIndex,
  now: Date,
): { index: LikeIndex; purgedRecords: number } {
  const cutoffMs = now.getTime() - RETENTION_DAYS * MS_PER_DAY;
  const { index: kept, dropped } = filterByCutoff(index, cutoffMs);
  return { index: kept, purgedRecords: dropped };
}

/**
 * 判定に使う範囲へ絞った**新しい**インデックスを返す。保存はしない。
 *
 * 既定は purgeLikeIndex と同じ 7 日。**基準は `itemPostedAt`（記事の投稿時刻）**
 * であって、いいねが押された時刻ではない。フルモードが辿る過去記事は
 * 定義上「過去」なので、窓を短くするとここで落ちる。ユーザーが対象を
 * 絞りたいときだけ短くする値になっている。
 */
export function withinLookback(index: LikeIndex, lookbackDays: number, now: Date): LikeIndex {
  const cutoffMs = now.getTime() - lookbackDays * MS_PER_DAY;
  return filterByCutoff(index, cutoffMs).index;
}

/**
 * 保持期間内に投稿された記事か。**取りに行く前に捨てるために使う。**
 *
 * purgeLikeIndex は保存の直前に同じ基準で切る。それより古い記事の likes を
 * 取得しても必ず消えるので、リクエストを使うだけ無駄になる。
 * 実測（2026-08-24）: 45 記事を取得して保存されたのは 6 本（13%）。
 *
 * 判定の窓（lookbackDays）ではなく保持期間で切るのは、ユーザーが窓を
 * 短くしても蓄積は続けるため。窓は後から広げられるが、取らなかった
 * データは戻らない。
 */
export function isWithinRetention(itemPostedAt: IsoDateTime, now: Date): boolean {
  const posted = toEpochMs(itemPostedAt);
  return posted !== null && posted >= now.getTime() - RETENTION_DAYS * MS_PER_DAY;
}

/** 蓄積状況をログに出すための件数。「動いていない」との誤認を防ぐのが目的 */
export function countRecords(index: LikeIndex): number {
  let total = 0;
  for (const entry of Object.values(index)) total += entry.likes.length;
  return total;
}
