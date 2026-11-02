/**
 * 候補を一覧に出すかの規則。**ポップアップの一覧とバッジで 1 つを共有する。**
 *
 * 【なぜ lib に置くのか】
 * 使うのは popup-state の hideOffTrend（一覧）と background の badge-sync（バッジ）。
 * background が popup のモジュールを読むのは筋が違うので、どちらからも読める
 * 置き場にした。2026-11-02 に同じ式を 2 箇所へ書き、コメントで「揃える」と
 * 約束していたが、片方だけ直すと一覧の件数とバッジが食い違う
 * （BURST_WINDOW_CHOICES を 1 箇所に集めたのと同じ理由）。
 */
import type { MuteRecord } from '../types/domain';

/**
 * トレンドに出ていないことを理由に隠すか。**純粋関数。**
 *
 * 【ミュート済みと確認できた著者は隠さない】（2026-11-02 ユーザー「折りたたみに残す」）
 * ミュートすると次の読み込みからトレンドに出なくなる（TrendSnapshot の JSDoc）。
 * 隠すと「ミュート済みだけ」の折りたたみが常に空になり、**誤検知でミュートした
 * 著者を「誤り」に直す道が消える**（OQ-16）。トレンドに居ない理由はミュートの行が
 * 言うので、矛盾にはならない。
 *
 * 【outcome ではなく mutedAt で見る】
 * 見送りや失敗の記録（`mutedAt` が無い）は、トレンドに居ない理由の説明にならない。
 * 逆に、確認済みのあとで見送りを記録しても `mutedAt` は残る（storage.recordMuteOutcome）。
 * outcome で見ると、「誤り」→「妥当」と押し直した瞬間に一覧から消える。
 *
 * @param offTrend スナップショットに居なかったと**確認できた**か。スナップショットが
 *   無いときは false を渡す（未確認を不在と読み替えない）
 */
export function isHiddenAsOffTrend(
  offTrend: boolean,
  mute: MuteRecord | null | undefined,
): boolean {
  return offTrend && mute?.mutedAt === undefined;
}
