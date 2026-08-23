/**
 * 著者の過去記事をいつ辿ったかの記録。
 *
 * この層は純粋関数だけで構成する（storage も fetch も触らない）。
 * like-index.ts と同じ思想で、「どの著者を辿ってよいか」の判断を
 * テスト可能な形で 1 箇所に集める。
 *
 * 【なぜ記録が要るか】
 * 「その著者を一度でも訪れたか」は記事 ID の集合からは判定できない。
 * 記事が 1 本しか無い著者と、まだ辿っていない著者が同じ見え方になる。
 * 記録を持たずに「新しい記事の著者だけ辿る」形にしていた結果、ライトモードで
 * 蓄積したあとにトークンを設定した人は、その著者の過去記事を **永久に**
 * 取りに行かなかった（2026-08-23 の実機で判明）。
 *
 * 【now を引数で受け取る理由】
 * 関数内で new Date() を呼ぶとテストが実行時刻に依存して壊れる。
 * 実際、2026-08-20 に緑だった scanner のテストが 8/23 に 3 件落ちた。
 */
import { toEpochMs } from '../detect/like-index';
import type { AccountHandle, AuthorVisits, LikeIndex } from '../types/domain';

/**
 * 著者を再訪する間隔。
 *
 * 過去記事は 1 回の訪問で MAX_EXTRA_ITEMS_PER_AUTHOR 本ずつ遡る。再訪すると
 * 次の 2 本に進むので、この値は「どれだけ速く遡るか」を決める。フルモードは
 * 1 スキャン約 108 req、認証枠は 1000 req/h。24 時間なら 1 日 11% で収まる。
 *
 * OQ-14（同じ記事の likes をいつ取り直すか）とは **別の値**。混ぜない。
 */
export const AUTHOR_REVISIT_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * まだ訪れていない、または前回から AUTHOR_REVISIT_HOURS 経った著者を返す。
 *
 * 重複は畳む。トレンドに同じ著者の記事が 2 本あると handles に 2 回出るため、
 * そのまま辿ると同じ著者一覧を 2 回叩く。
 *
 * 記録がパースできない場合は「未訪問」とみなす。**訪ねすぎる方が、永久に
 * 訪ねないより無害**（枠は 429 が返るまで走る設計で吸収できる）。
 */
export function authorsToVisit(
  handles: AccountHandle[],
  visits: AuthorVisits,
  now: Date,
): AccountHandle[] {
  const cutoffMs = now.getTime() - AUTHOR_REVISIT_HOURS * MS_PER_HOUR;
  const due = new Set<AccountHandle>();

  for (const handle of handles) {
    const last = visits[handle];
    if (last === undefined) {
      due.add(handle);
      continue;
    }
    const visitedMs = toEpochMs(last);
    // ちょうど AUTHOR_REVISIT_HOURS 経過したら再訪する（境界は再訪側）
    if (visitedMs === null || visitedMs <= cutoffMs) due.add(handle);
  }

  return [...due];
}

/**
 * 訪問した著者の時刻を now にした**新しい**記録を返す。
 *
 * 渡された visits は書き換えない（CLAUDE.md の coding-style）。
 * 呼び出し側は「実際に辿れた著者」だけを渡すこと。429 で辿れなかった著者まで
 * 記録すると、次のスキャンで飛ばされて永久に取りこぼす。
 */
export function recordVisits(
  visits: AuthorVisits,
  handles: AccountHandle[],
  now: Date,
): AuthorVisits {
  const at = now.toISOString();
  const next: AuthorVisits = { ...visits };
  for (const handle of handles) next[handle] = at;
  return next;
}

/** インデックスに現れる著者の一覧 */
function authorsIn(index: LikeIndex): Set<AccountHandle> {
  const authors = new Set<AccountHandle>();
  for (const entry of Object.values(index)) {
    for (const record of entry.likes) authors.add(record.authorHandle);
  }
  return authors;
}

/**
 * インデックスに居ない著者の記録を落とす。purgeLikeIndex と同じタイミングで呼ぶ。
 *
 * 記録だけが残り続けると、保持期間を過ぎた著者を「訪問済み」として
 * 飛ばし続けることになる。落とせば、再びトレンドに出たときに辿り直せる。
 */
export function pruneVisits(visits: AuthorVisits, index: LikeIndex): AuthorVisits {
  const alive = authorsIn(index);
  const kept: AuthorVisits = {};
  for (const [handle, at] of Object.entries(visits)) {
    if (alive.has(handle)) kept[handle] = at;
  }
  return kept;
}
