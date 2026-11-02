/**
 * バッジの件数を storage から決める。**ポップアップの一覧と同じ入力・同じ規則で数える。**
 *
 * 【入力を storage に揃えた理由】（2026-11-02）
 * 当初はスキャンが受け取ったトレンド記事で数えていたが、一覧は保存済みの
 * スナップショットで絞る。入力が 2 つあると、スナップショットの保存に失敗したとき
 * 「バッジは数えるが一覧には出ない」が起きる。規則も lib/visibility の
 * isHiddenAsOffTrend を一覧（popup-state の hideOffTrend）と共有する。
 *
 * 【呼び出し元】
 * スキャンの保存（scan-persist）と、スナップショットの保存（service-worker）。
 * ほかにスクショ用ビルドの fixture-seed が、撮影前の状態を作るときに呼ぶ。
 * スキャン中に別タブでトレンドを開くと 2 本目のスキャンは走らないので、
 * スナップショット側からも数え直さないと、ポップアップを開くまで前の件数が残る。
 */
import * as storage from '../lib/storage';
import { updateBadge } from '../lib/badge';
import { isHiddenAsOffTrend } from '../lib/visibility';
import type { Candidate, MuteLog, TrendSnapshot } from '../types/domain';

/** 一覧に出る候補の数。**純粋関数。**スナップショットが無ければ全件 */
export function countShownCandidates(
  candidates: Candidate[],
  muteLog: MuteLog,
  snapshot: TrendSnapshot | null,
): number {
  const onTrend = snapshot === null ? null : new Set(snapshot.authors);
  return candidates.filter(
    (candidate) =>
      !isHiddenAsOffTrend(
        onTrend !== null && !onTrend.has(candidate.authorHandle),
        muteLog[candidate.authorHandle],
      ),
  ).length;
}

/** 429 の状態が分かっているとき（スキャンの直後）に使う */
export async function syncBadge(rateLimited: boolean): Promise<void> {
  const [candidates, muteLog, snapshot] = await Promise.all([
    storage.getCandidates(),
    storage.getMuteLog(),
    storage.getTrendSnapshot(),
  ]);
  await updateBadge(countShownCandidates(candidates, muteLog, snapshot), rateLimited);
}

/**
 * 429 の状態も storage から読む。スキャンを経ない経路（スナップショットの保存）で使う。
 * 判定はポップアップの rateLimitNotice と同じ（残りが 0 秒以下なら止まっていない）。
 */
export async function refreshBadge(now: Date): Promise<void> {
  const until = await storage.getRateLimitedUntil();
  await syncBadge(until !== null && until > Math.floor(now.getTime() / 1000));
}
