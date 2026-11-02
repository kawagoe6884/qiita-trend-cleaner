/**
 * 候補 1 件のミュートの行と、押し直しの案内。**純粋関数だけを置く。**
 *
 * 【なぜ popup-state から分けたのか】（2026-11-02）
 * popup-state が 947 行になり、ソースファイルの目安（800 行）を超えた。
 * ミュートを依頼する側（requestMute / skipMute。chrome.tabs と storage を触る）は
 * popup-state に残し、記録から文を作る側をここへ移した。**振る舞いは変えていない。**
 *
 * isMuteRetryReady は文言ではないが、describeMuteRetry / describeRetryNotice と
 * 同じ条件を共有するので一緒に置く。popup-state の partitionViews もこれを使う
 * （押し直せる候補は畳まない）。
 */
import { formatJst } from './popup-copy';
import type { IsoDateTime, MuteOutcome, MuteRecord } from '../../types/domain';
import type { CandidateView } from './popup-state';

/**
 * 記録 1 件の文言。**ミュート済みだと確認できたことがあるかで言い方を変える。**
 *
 * 【なぜ outcome だけでは足りないのか】
 * ミュートしたあと押し直すと、**ページを読み込み直す前なら** `already-muted`、
 * **読み込み直したあとなら** `not-on-page` が返る。outcome だけを見ると、
 * ミュート済みの著者に「ミュートしませんでした」と言ってしまう（2026-09-17 まで
 * の文言では「次に出てきたときに押し直してください」と案内していた）。
 *
 * 【現在形で言わない】（2026-09-16）
 * 以前は「ミュート済みです。…ここには出てきません。」と書いていた。
 * **2 つとも実測で偽になった** — 押した直後の DOM には記事が残っており
 * （ユーザー実測: 3 件のうち 1 件をミュートしても 3 件のまま）、ユーザーが
 * Qiita 側で解除すれば当然また出てくる。**現在形の主張は、解除された瞬間に
 * 嘘になり、しかも拡張はそれを知らない。**確認できた時刻に紐づければ偽にならない。
 *
 * 解除を検知できたときは記録ごと消えるので（`storage.forgetMuteConfirmation`）、
 * ここに来る時点で「解除の証拠はまだ無い」。だから時刻で言うのが最も強い主張。
 *
 * 【`menu-unavailable` を特例から外した】（2026-08-29）
 * 以前は「既にミュート済みなら `menu-unavailable` に落ちる」ことを根拠に、
 * ここで言い換えていた。**その前提が成立しなくなった** — 解除側の文言を読んで
 * `already-muted` を返すようになったので、`menu-unavailable` は**本当に画面
 * 構造が変わったときだけ**に絞られる。言い換えを続けると、直すべき不具合を
 * 「ミュート済みです」で隠してしまう。
 */
export function describeMuteRecord(record: MuteRecord): string {
  if (record.mutedAt === undefined) return describeMuteOutcome(record.outcome);
  switch (record.outcome) {
    case 'muted':
    case 'already-muted':
    case 'not-on-page':
      // この 3 つは「ミュート中である」という状態の主張。**現在形をやめて
      // 時刻に紐づける。**解除の導線はここに書かない（最終スキャンの下に常設）
      return describeConfirmedMute(record.mutedAt);
    case 'menu-unavailable':
    case 'timeout':
    case 'no-trend-tab':
    case 'unreachable':
      // **失敗を確認時刻で塗り潰さない。**直すべき不具合か、ユーザーが取れる
      // 行動があるものばかりで、隠すと気づけなくなる（`menu-unavailable` を
      // 特例から外したのと同じ理由）
      return describeMuteOutcome(record.outcome);
  }
}

/**
 * 失敗した試行のうち、**あとから読み込んだトレンドに著者が居れば押し直す価値がある**もの。
 *
 * default を書かない（describeMuteOutcome と同じ）。MuteOutcome に値を足したとき、
 * ここで決め忘れると型エラーになる。
 */
function isRetryableOutcome(outcome: MuteOutcome): boolean {
  switch (outcome) {
    case 'not-on-page':
    case 'no-trend-tab':
    case 'unreachable':
    case 'timeout':
      // どれも「押せる状態に無かった」か「効いたか分からない」。新しく読み込んだ
      // トレンドに居れば、その時点でミュートされておらず、表示中のカードもある
      return true;
    case 'menu-unavailable':
      // 画面構造の変化。押し直しても同じ所で落ちるので、読み込みのたびに促すと
      // **直すべき不具合を「もう一度押してください」で覆う**
      return false;
    case 'muted':
    case 'already-muted':
      // 成功した試行。押し直しを促す理由が無い
      return false;
  }
}

type RetryReadyView = CandidateView & { onTrendAt: IsoDateTime };

/**
 * 「妥当」を押し直せばミュートできる見込みがあるか。**5 つとも満たすときだけ true。**
 *
 *   1. ミュート連動がオン — オフだと「妥当」を押してもミュートは走らない
 *   2. 評価が「妥当」 — 「誤り」に変えた著者を促さない
 *   3. **ミュートできていない記録がある**（試して失敗したか、トレンド外で見送った。
 *      記録があり、`mutedAt` が無い）
 *   4. 失敗の理由が、読み込み直せば解消しうる（isRetryableOutcome）
 *   5. **押した時刻より後に撮ったスナップショットに居る**
 *
 * 【5 を時刻で絞る】
 * 押す前に撮ったスナップショットに居ただけなら、押した直後に「押し直せます」と
 * 出てしまう（例: トレンドのタブを閉じてから押して `no-trend-tab` になった直後）。
 * 読めない時刻は NaN になり、比較が必ず false になる — **促さない側に倒れる。**
 *
 * 【記録が無い著者は促さない】
 * 解除を検知すると記録ごと消える（`storage.forgetMuteConfirmation`）。記録の有無を
 * 見ずに「妥当・未確認・トレンドに居る」だけで判定すると、**ユーザーが Qiita 側で
 * 自分で解除した著者に「ミュートがまだ」と言い続ける。**
 */
export function isMuteRetryReady(
  view: CandidateView,
  muteOnValid: boolean,
): view is RetryReadyView {
  const { mute, onTrendAt } = view;
  if (!muteOnValid || view.verdict !== 'valid') return false;
  if (mute === null || mute.mutedAt !== undefined || onTrendAt === null) return false;
  if (!isRetryableOutcome(mute.outcome)) return false;
  return Date.parse(onTrendAt) > Date.parse(mute.at);
}

/**
 * 押し直せる候補の行。**押し直せないなら空文字**（describeFold と同じ規約）。
 *
 * 失敗の文言（describeMuteRecord）の**代わりに**出す。押したときの理由
 * （「トレンドに記事が無く…」）は、あとから撮ったスナップショットで古くなっている。
 *
 * 時刻はスナップショットのもの。**「いまトレンドに出ています」とは言わない。**
 */
export function describeMuteRetry(view: CandidateView, muteOnValid: boolean): string {
  if (!isMuteRetryReady(view, muteOnValid)) return '';
  return `${formatJst(view.onTrendAt)} 時点でトレンドに出ています。「妥当」を押し直すとミュートします。`;
}

/**
 * ポップアップの先頭に出す案内。**押し直せる候補が 1 件も無ければ空文字。**
 *
 * 【なぜ要るのか】（2026-09-17 ユーザー「A で直して」）
 * トレンド外の候補で先に「妥当」を押すと、ミュートは走らない（押す対象のカードが
 * 表示中のページに無い）。その著者がトレンドに戻っても、**拡張がもう一度押す
 * 契機は無く、ユーザーが気づかなければミュートの意図が黙って失われる。**
 * 戻ってきたことを知らせ、押すのはユーザーに任せる — **勝手にミュートしない。**
 *
 * 【#notice（429）とは別の器に出す】
 * 429 の案内は storage の変更で丸ごと書き換わる（popup-page の watchRateLimit）。
 * 同じ器に入れると、枠が戻った瞬間にこちらの案内まで消える。
 */
export function describeRetryNotice(views: CandidateView[], muteOnValid: boolean): string {
  const ready = views.filter((view): view is RetryReadyView => isMuteRetryReady(view, muteOnValid));
  const [first] = ready;
  if (first === undefined) return '';
  return `${formatJst(first.onTrendAt)} 時点のトレンドに、ミュートがまだの候補が ${String(ready.length)} 件出ています。`;
}

/** ミュート済みだと確認できた時刻の文言。**現在形で言わない**（describeMuteRecord の JSDoc） */
function describeConfirmedMute(mutedAt: IsoDateTime): string {
  return `${formatJst(mutedAt)} にミュート済みであることを確認しました。`;
}

/**
 * その試行で、Qiita 側のミュートが**入ったかもしれない**か。
 *
 * default を書かない（isRetryableOutcome と同じ）。MuteOutcome に値を足したとき、
 * ここで決め忘れると型エラーになる。
 */
function mayHaveMuted(outcome: MuteOutcome): boolean {
  switch (outcome) {
    case 'muted':
    case 'already-muted':
      // 入った。通常は mutedAt が立つので、ここに来るのは mutedAt の無い古い記録だけ
      return true;
    case 'timeout':
      // 押したが完了を確認できなかった。**入ったかどうか分からない**
      return true;
    case 'not-on-page':
    case 'no-trend-tab':
    case 'unreachable':
    case 'menu-unavailable':
      // 押していない（カードもタブも届く先もメニューの項目も無かった、または見送った）
      return false;
  }
}

/**
 * 候補 1 件のミュートの行。**出さないなら空文字**（describeFold と同じ規約）。
 *
 * 【「妥当」でなくなった候補には、ミュートしようとした経緯を出さない】（2026-09-17 実機）
 * 「妥当」→ トレンド外で見送り →「誤り」と押すと、「押したときトレンドに記事が無く、
 * ミュートしませんでした。」が残っていた。**ミュートするつもりが無くなった候補に、
 * ミュートしなかった理由を言い続けていた。**Qiita 側で何も起きていないと分かっている
 * 記録（mayHaveMuted が false）は、評価が「妥当」でなければ出さない。
 *
 * 【ミュート連動をオフにした候補も同じ扱い】（2026-09-17）
 * オフでは「妥当」を押してもミュートは走らない。`no-trend-tab` の「トレンドページを
 * 開いてから押してください。」に従っても何も起きず、**同じ指示が残り続けていた。**
 * 確認時刻（起きた事実）と `timeout`（Qiita のミュート設定で確かめる案内）は
 * 拡張のボタンに頼らないので、オフでも残す。オンに戻せば元の出し方に戻る
 * （記録は消していない）。
 *
 * 【Qiita 側に残っているかもしれないものは残す】
 * 「誤り」を押しても Qiita 側のミュートは解除されない（partitionViews の JSDoc）。
 *   - `mutedAt` がある … 確認時刻だけを言う（失敗の文言は「押し直す」前提なので出さない）。
 *     消すと、誤検知でミュートした著者を解除しに行く手がかりが無くなる
 *     （2026-08-24 の orch-review が見つけた欠陥と同じ形）
 *   - `timeout` … 入ったか分からない。**「誤り」にした直後こそミュート設定を確かめる
 *     必要がある**ので、「確認してください」を消さない
 *
 * **記録そのものは消さない。**表示だけを変える。「妥当」に押し直せば、その結果で
 * また言い直す。
 *
 * 【折りたたみはこの出し分けに揃えない】
 * partitionViews の 'muted' と hasMutedInFold は評価を見ない（`mutedAt` だけで決める）。
 * 評価の条件を足すと、前者は「ミュート済み N 件」から「誤り」に変えた著者を落とし、
 * 後者は、畳んだ中のミュート済みが「誤り」の著者だけのとき #fold-note（「誤り」を
 * 押しても解除されない）を出さなくなる。**どちらも誤検知でミュートした著者で起きる**（OQ-16）。
 */
export function describeMuteStatus(view: CandidateView, muteOnValid: boolean): string {
  const { mute } = view;
  if (mute === null) return '';
  if (view.verdict !== 'valid' || !muteOnValid) {
    if (mute.mutedAt !== undefined) return describeConfirmedMute(mute.mutedAt);
    return mayHaveMuted(mute.outcome) ? describeMuteRecord(mute) : '';
  }
  // 押し直せるなら、押したときの理由より新しい事実がある
  const retry = describeMuteRetry(view, muteOnValid);
  return retry === '' ? describeMuteRecord(mute) : retry;
}

/**
 * 結果ごとの文言。**断定しない**（設計上の約束 6）。
 *
 * 確認済み（`mutedAt`）の記録の言い換えは describeConfirmedMute が行う
 * （describeMuteRecord と describeMuteStatus から呼ぶ）。ここは
 * 「その試行で何が起きたか」だけを言う。
 *
 * default を書かないこと。MuteOutcome に値を足したとき、TypeScript が漏れを教える。
 */
export function describeMuteOutcome(outcome: MuteOutcome): string {
  switch (outcome) {
    case 'muted':
      return 'Qiita 側でミュートしました。';
    case 'already-muted':
      // **押していない。**メニューの項目が解除側だったので、その時点で
      // ミュート中だと確認できた。**解除の導線はここに書かない**
      // （最終スキャンの下に常設してある。候補の数だけ同じ文が並ぶのを避ける）
      return '既に Qiita 側でミュート済みでした。';
    case 'not-on-page':
      // 【現在形と約束をやめた】（2026-09-17）以前は「いま開いているトレンドページに
      // …次に出てきたときに押し直してください。」。**押したあとに読む文なので
      // 「いま」は押した時点を指していない。**「次に出てきたとき」はミュート済みの
      // 著者には来ない（2026-09-16 にトレンド外の行で直したのと同じ誤り）。
      // 戻ってきたときは describeMuteRetry がこの行を差し替えて案内する
      return '押したときトレンドに記事が無く、ミュートしませんでした。';
    case 'no-trend-tab':
      return 'トレンドページを開いてから押してください。';
    case 'menu-unavailable':
      // **「既にミュート済みか」を外した。**それは already-muted で言い分ける
      // ようになったので、ここに残すと直すべき不具合を推測で薄めることになる
      return 'ミュートのメニューが見つかりませんでした。Qiita の画面構造が変わった可能性があります。';
    case 'timeout':
      return '完了の通知を確認できませんでした。ミュート設定で結果を確認してください。';
    case 'unreachable':
      return 'トレンドページに届きませんでした。ページを再読み込みしてから押し直してください。';
  }
}
