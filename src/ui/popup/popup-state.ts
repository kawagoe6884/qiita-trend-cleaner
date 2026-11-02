/**
 * ポップアップの状態を作る。
 *
 * 文言は popup-copy（ミュートの行は popup-mute-copy）にある。2026-11-02 に
 * このファイルが 800 行の目安を超えたので分けた。
 *
 * 【DOM を参照しない理由】
 * document を触るのは popup-page.ts の責務にする。token-form.ts と同じ思想で、
 * 「適合率の分母が 0 のときは null」のような重要な性質をユニットテストで固定する。
 *
 * 【API を 1 本も叩かない】
 * detectCandidates は純粋関数で、入力は storage.local の likeIndex にある。
 * スライダーを動かしてもレート枠は 1 も減らない。取得は
 * 「トレンドページを開いたとき」だけという設計を、UI 側から崩さない。
 */
import * as storage from '../../lib/storage';
import { detectCandidates } from '../../detect/detector';
import { countAuthorCoverage } from '../../detect/like-index';
import { isTrendPage } from '../../dom/trend-reader';
import { isHiddenAsOffTrend } from '../../lib/visibility';
import { isMuteOutcome, BURST_WINDOW_CHOICES } from '../../types/domain';
import { isMuteRetryReady } from './popup-mute-copy';
import type {
  AccountHandle,
  Candidate,
  FeedbackLog,
  FoldTarget,
  IsoDateTime,
  ItemId,
  MuteLog,
  MuteOutcome,
  MuteRecord,
  Settings,
  TrendSnapshot,
  Verdict,
} from '../../types/domain';
import type { AuthorCoverage } from '../../detect/like-index';
import type { QtgRequest, QtgResponse } from '../../types/messages';

/** 端数は切り上げる。「あと 0 分」と出さないため */
const SECONDS_PER_MINUTE = 60;

export interface Precision {
  valid: number;
  falsePositive: number;
  /**
   * 妥当 / (妥当 + 誤り)。**分母が 0 のときは null。**
   *
   * 0 にすると「測ったら 0% だった」と「まだ測っていない」が区別できなくなる。
   * **適合率はユーザーが自分の調整結果を見る計器**（Phase 9 で方針転換。
   * 開発者が 80% を目標に追い込むのはやめた）。取り違えると、条件を
   * ゆるめるべきか締めるべきかの判断が逆になる。
   */
  ratio: number | null;
}

/** 判定の集計。適合率は PRD の式（妥当 / (妥当 + 誤り)）そのまま */
export function precisionOf(feedback: FeedbackLog): Precision {
  let valid = 0;
  let falsePositive = 0;
  for (const verdict of Object.values(feedback)) {
    if (verdict === 'valid') valid += 1;
    else falsePositive += 1;
  }
  const total = valid + falsePositive;
  return { valid, falsePositive, ratio: total === 0 ? null : valid / total };
}

/**
 * 「妥当 / 誤り」の左に置くラベル。
 *
 * **ボタンだけでは何に対する判断か読み取れない。**評価する対象は
 * **検出そのもの**（当たっていたか）であって、著者の人格ではない。
 * describeCall が一覧の頭で言っていることを、行ごとにも短く置く。
 *
 * 「不正」「スパム」とは書かない（設計上の約束 6）。
 */
export const VERDICT_PROMPT = 'この検出は';

export interface Evidence {
  itemId: ItemId;
  url: string;
}

export interface CandidateView {
  candidate: Candidate;
  verdict: Verdict | null;
  /**
   * 根拠として提示する記事へのリンク。
   *
   * **これが無いとユーザーは記事を読めず、「妥当 / 誤り」が当てずっぽうになる。**
   * 当てずっぽうから出る適合率は指標として無価値なので、リンクは飾りではない。
   */
  evidence: Evidence[];
  /**
   * 最後にミュートを試みた結果、または**トレンド外で見送った記録**（`skipMute`。
   * 送らずに `not-on-page` を書く）。**どちらも無ければ null。**
   *
   * 「まだ何もしていない」と「ミュートできていない」を取り違えると、ユーザーは
   * 押し直すべきかどうかが分からなくなる（適合率の分母 0 を 0% にしないのと同じ話）。
   * **null でないことは「試した」を意味しない**（2026-09-17 に見送りが加わった）。
   */
  mute: MuteRecord | null;
  /**
   * **その時点でトレンドに出ていなかった**と確認できたスナップショットの時刻。
   * 出ていた場合と、**スナップショットをまだ 1 つも持っていない場合**は null。
   *
   * 候補は 7 日ぶんの蓄積から出るので、5 日前に検出した著者はトレンドから
   * 去ったあとも候補に残る。**これが立っている候補は、ミュート済みでなければ一覧に
   * 出さない**（{@link hideOffTrend}。2026-11-02 まではこの時刻を添えて出していた）。
   * 一覧に残ったミュート済みの著者で「妥当」を押し直したときは、popup-page の
   * muteOnVerdict がこれを見て依頼を送らずに見送る。
   *
   * 【値は null かどうかしか読んでいない】（2026-11-02）
   * 時刻を画面に出していた describeOffTrend を消したので、いまは null 判定だけに
   * 使う。時刻のまま持つのは onTrendAt（押し直しの判定が時刻を比べる）と対にするため。
   */
  offTrendAt: IsoDateTime | null;
  /**
   * **その時点でトレンドに出ていた**と確認できたスナップショットの時刻。
   * 出ていなかった場合と、スナップショットをまだ持っていない場合は null。
   *
   * ミュートを押し直せるかの判定（{@link isMuteRetryReady}）にだけ使う。
   * **押した時刻より後に撮られたスナップショットに居れば**、そのとき表示中の
   * カードがあり、ミュートもされていない（`storage.forgetMuteConfirmation` と同じ推論）。
   */
  onTrendAt: IsoDateTime | null;
}

/**
 * 候補に判定・根拠リンク・ミュートの結果を重ねる。Candidate 自体は変更しない。
 *
 * muteLog と trendSnapshot を省略できるようにしてあるのは、それらを使わない
 * 呼び出し（Phase 6 からの経路）を書き換えずに済ませるため。
 *
 * **スナップショットが無いときは全員 null。**「まだ一度もトレンドを開いて
 * いない」を「全員トレンドに出ていない」と読み替えると、更新直後のユーザーの
 * 一覧から候補 30 件ぶんが消える（hideOffTrend。itemCoveredMinutes で踏んだのと同じ形）。
 */
export function toViews(
  candidates: Candidate[],
  feedback: FeedbackLog,
  muteLog: MuteLog = {},
  trendSnapshot: TrendSnapshot | null = null,
): CandidateView[] {
  const onTrend = trendSnapshot === null ? null : new Set(trendSnapshot.authors);
  return candidates.map((candidate) => ({
    candidate,
    verdict: feedback[candidate.authorHandle] ?? null,
    evidence: candidate.sharedItemIds.map((itemId) => ({
      itemId,
      url: `https://qiita.com/${candidate.authorHandle}/items/${itemId}`,
    })),
    mute: muteLog[candidate.authorHandle] ?? null,
    offTrendAt:
      trendSnapshot === null || onTrend === null || onTrend.has(candidate.authorHandle)
        ? null
        : trendSnapshot.at,
    onTrendAt:
      trendSnapshot !== null && onTrend !== null && onTrend.has(candidate.authorHandle)
        ? trendSnapshot.at
        : null,
  }));
}

/**
 * トレンドに出ていなかった候補を外す。**純粋関数。順序は保つ。**
 *
 * 【なぜ外すのか】（2026-11-02 ユーザー「トレンドページにいないのに、拡張機能に
 * いるという矛盾を解消したい」）
 * 候補は 7 日ぶんの蓄積から出るので、トレンドを去った著者も一覧に残っていた。
 * 「◯◯ 時点でトレンド外」と書き添えても、画面に居ない著者が並ぶ違和感は消えなかった。
 * **外すのは表示だけ。**蓄積・候補の保存・判定（妥当 / 誤り）は消さないので、
 * トレンドに戻れば一覧にも戻る。
 *
 * 【スナップショットが無ければ 1 件も外さない】
 * offTrendAt は「出ていなかったと確認できた」ときだけ時刻を持つ（toViews）。
 * 未確認を不在と読み替えると、更新直後のユーザーの一覧が理由も出ないまま空になる。
 *
 * 【ミュート済みと確認できた著者は外さない】（2026-11-02 ユーザー「折りたたみに残す」）
 * 規則そのものは lib/visibility の isHiddenAsOffTrend にある。**バッジ（background の
 * badge-sync）も同じ関数で数える**ので、一覧の件数とバッジは食い違わない。
 */
export function hideOffTrend(views: CandidateView[]): CandidateView[] {
  return views.filter((view) => !isHiddenAsOffTrend(view.offTrendAt !== null, view.mute));
}

/**
 * 一覧に出すビューを作る。**ポップアップが候補を描くときは必ずここを通す。**
 *
 * toViews と hideOffTrend を呼び出し側で組み合わせると、3 つ目の呼び出し元が
 * hideOffTrend を付け忘れたとき、トレンド外の著者が黙って戻ってくる
 * （applySettings が trendSnapshot を読み忘れていた 2026-09-17 と同じ形）。
 */
export function toShownViews(
  candidates: Candidate[],
  feedback: FeedbackLog,
  muteLog: MuteLog,
  trendSnapshot: TrendSnapshot | null,
): CandidateView[] {
  return hideOffTrend(toViews(candidates, feedback, muteLog, trendSnapshot));
}

export interface PartitionedViews {
  open: CandidateView[];
  folded: CandidateView[];
}

/**
 * 折りたたむものと出すものに分ける。**純粋関数。順序は保つ。**
 *
 * 【mutedAt で見る。outcome では見ない】
 * 押し直したときの outcome は、ページを読み込み直したかで `already-muted` にも
 * `not-on-page` にも転ぶ（MuteRecord.mutedAt の JSDoc）。outcome で判定すると、
 * **押し直した瞬間に折りたたみから飛び出す。**
 *
 * 解除を検知すると記録ごと消えるので（`storage.forgetMuteConfirmation`）、
 * **解除された著者はここから自然に外れて open 側に戻る。**それが正しい —
 * もう一度ミュートするかどうかを選べる状態に戻したい。
 *
 * 【'muted' では「誤り」を押しても外れない】
 * 「誤り」を押しても Qiita 側のミュートは解除されない。折りたたみに残るのは
 * 事実として正しい。解除の導線は foldNote が出す。
 *
 * 【押し直せる候補は畳まない】（2026-09-17）
 * 先頭の案内（describeRetryNotice）が「ミュートがまだの候補があります」と言うのに、
 * 'valid' / 'judged' ではその候補が畳まれていて、**開いて探すまで押せない。**
 * まだ済んでいないものを「済んだもの」の置き場に入れない。
 */
export function partitionViews(
  views: CandidateView[],
  target: FoldTarget,
  muteOnValid: boolean,
): PartitionedViews {
  const shouldFold = (view: CandidateView): boolean => {
    if (isMuteRetryReady(view, muteOnValid)) return false;
    switch (target) {
      case 'none':
        return false;
      case 'muted':
        return view.mute?.mutedAt !== undefined;
      case 'valid':
        return view.verdict === 'valid';
      case 'judged':
        return view.verdict !== null;
    }
  };
  return {
    open: views.filter((view) => !shouldFold(view)),
    folded: views.filter(shouldFold),
  };
}

/**
 * 折りたたみの中に注意書きを出すか。**ミュート済みが 1 件でもあるときだけ。**
 *
 * 「誤り」を押しても Qiita 側のミュートは解除されない。折りたたみは
 * 「視界から消す」方向の変更なので、**誤検知でミュートしたアカウントを
 * 再評価できなくする**という既知の失敗（OQ-16）と同じ形を持つ。
 * 解除の導線を添えることがその歯止めになる。
 *
 * **文言そのものは index.html に置いてある。**解除ページへのリンクを含む
 * ので、textContent で組み立てると押せない飾りになる（#mute-note と同じ形）。
 * ここが決めるのは出すか出さないかだけ。
 *
 * 1 件も無いときに出さないのは、'judged' で誰もミュートしていない場合に
 * 関係のない注意書きが常駐するのを避けるため。
 */
export function hasMutedInFold(folded: CandidateView[]): boolean {
  return folded.some((view) => view.mute?.mutedAt !== undefined);
}

/**
 * 429 の案内文。枠がまだ戻っていなければ残り分数を返す。
 *
 * until の単位は **Unix 秒**（Rate-Reset）。Date.now() はミリ秒なので割る。
 */
export function rateLimitNotice(until: number | null, now: Date): string | null {
  if (until === null) return null;
  const remaining = until - Math.floor(now.getTime() / 1000);
  if (remaining <= 0) return null;
  const minutes = Math.ceil(remaining / SECONDS_PER_MINUTE);
  return `Qiita API の 1 時間あたりの上限に達しました。あと ${String(minutes)} 分で再開できます。`;
}

/**
 * 「投稿から何分以内」で選べる値（分）。**定義は `types/domain.ts` にある。**
 *
 * 取得層（`scanner.ts` の `collectLikes`）が最大値を必要とするため移した。
 * 100 件を超える記事は末尾から遡って取るので、どこまで遡るかが
 * 「ユーザーが選びうる最大の窓」で決まる。**UI と取得層に同じ目盛りを 2 つ持つと、
 * 片方だけ直して「選べるのに測れない窓」ができる。**
 *
 * ここで再 export しているのは、呼び出し側（popup-page とテスト）を
 * 書き換えずに済ませるため。
 */
export { BURST_WINDOW_CHOICES };

/**
 * 分から目盛りの添字を引く。**一致しなければ最も近いものに寄せる。**
 *
 * 選択肢の一覧を変えたときに、保存済みの値がどこにも無くなりうる。
 * そのとき先頭へ倒すと、ユーザーの設定が黙って最短に変わる。
 */
export function windowIndexOf(minutes: number): number {
  let best = 0;
  for (let i = 1; i < BURST_WINDOW_CHOICES.length; i += 1) {
    const current = BURST_WINDOW_CHOICES[i] ?? 0;
    const chosen = BURST_WINDOW_CHOICES[best] ?? 0;
    if (Math.abs(current - minutes) < Math.abs(chosen - minutes)) best = i;
  }
  return best;
}

export interface PopupState {
  views: CandidateView[];
  precision: Precision;
  settings: Settings;
  rateLimitNotice: string | null;
  lastScanAt: IsoDateTime | null;
  /** トークンが設定されているか。**生のトークンは持たない** */
  hasToken: boolean;
  /** 蓄積があるか。候補ゼロの理由を言い分けるために使う */
  hasIndex: boolean;
  /**
   * 蓄積の著者の内訳。**ライトモードの説明に実数を出すために持つ。**
   * 追加の storage 読み取りは無い（loadPopupState が既に読んでいる index から数える）
   */
  authorCoverage: AuthorCoverage;
  /** 「妥当」と同時に Qiita 側でもミュートするか。**既定は false** */
  muteOnValid: boolean;
  /** 評価が済んだ候補を折りたたむ対象。**既定は 'none'** */
  foldTarget: FoldTarget;
  /**
   * 一覧の絞り込みに使ったスナップショットの時刻。**撮っていなければ null。**
   * 候補ゼロの案内（describeEmpty）が「いつのトレンドか」を言うために持つ
   */
  trendSnapshotAt: IsoDateTime | null;
}

/** 保存済みの状態をまとめて読む */
export async function loadPopupState(now: Date): Promise<PopupState> {
  const [
    candidates,
    feedback,
    settings,
    until,
    lastScan,
    hasToken,
    index,
    muteOnValid,
    muteLog,
    foldTarget,
    trendSnapshot,
  ] = await Promise.all([
    storage.getCandidates(),
    storage.getFeedback(),
    storage.getSettings(),
    storage.getRateLimitedUntil(),
    storage.getLastScanResult(),
    storage.hasToken(),
    storage.getLikeIndex(),
    storage.getMuteOnValid(),
    storage.getMuteLog(),
    storage.getFoldTarget(),
    storage.getTrendSnapshot(),
  ]);
  return {
    views: toShownViews(candidates, feedback, muteLog, trendSnapshot),
    precision: precisionOf(feedback),
    settings,
    rateLimitNotice: rateLimitNotice(until, now),
    lastScanAt: lastScan?.finishedAt ?? null,
    hasToken,
    hasIndex: Object.keys(index).length > 0,
    authorCoverage: countAuthorCoverage(index),
    muteOnValid,
    foldTarget,
    trendSnapshotAt: trendSnapshot?.at ?? null,
  };
}

/**
 * 閾値を確定して検出をやり直す。スライダーを **離したとき**（change）に呼ぶ。
 *
 * 【ドラッグ中（input）に呼んではいけない】
 * この関数は storage 全体を 2 回読み（getLikeIndex と getFeedback がどちらも
 * get(null)）、300 以上のアカウントに対して検出を回し、一覧を作り直す。
 * input は 1 px 動かすたびに発火するため、毎秒数十回これが走ると
 * ポップアップの描画スレッドが飽和し、**つまみがドラッグに追従しなくなる**。
 * さらに storage.sync は 1800 writes/hour（PRD 実測表）で、
 * ドラッグ中に保存すると数秒で上限に届く。
 *
 * candidates も一緒に保存する。Phase 7 の DOM 非表示がこれを読むので、
 * 画面に出ている候補と隠す対象がずれないようにする。
 */
export async function applySettings(settings: Settings, now: Date): Promise<CandidateView[]> {
  // muteLog も読む。読まないと、**つまみを 1 つ動かした瞬間にミュートの結果表示が
  // 消える**（Candidate.verdict を持たせなかったのと同じ形の失敗）。
  // trendSnapshot も同じ理由で読む — **2026-09-17 まで読んでいなかった。**
  // loadPopupState にだけ配線し、つまみを動かすとトレンド不在の行が消えていた。
  // いまは不在の候補を出さないので、読み忘れると逆に**つまみを動かした瞬間に現れる**
  const [index, feedback, muteLog, trendSnapshot] = await Promise.all([
    storage.getLikeIndex(),
    storage.getFeedback(),
    storage.getMuteLog(),
    storage.getTrendSnapshot(),
  ]);
  const candidates = detectCandidates(index, settings, now);
  await storage.saveSettings(settings);
  await storage.saveCandidates(candidates);
  return toShownViews(candidates, feedback, muteLog, trendSnapshot);
}

/** 判定を記録し、更新後の適合率を返す。saveVerdict の戻り値を使い、読み直さない */
export async function recordVerdict(handle: AccountHandle, verdict: Verdict): Promise<Precision> {
  return precisionOf(await storage.saveVerdict(handle, verdict));
}

/** タブを探す範囲。manifest の host_permissions と同じ */
const QIITA_TAB_PATTERN = 'https://qiita.com/*';

/** タブの URL がトレンドページか。パスの判定は trend-reader に任せ、2 箇所に書かない */
function isTrendTabUrl(url: string | undefined): boolean {
  if (url === undefined || url === '') return false;
  try {
    return isTrendPage(new URL(url).pathname);
  } catch {
    // 解析できない URL は対象外。例外は投げない
    return false;
  }
}

/**
 * トレンドページを開いているタブを **1 枚だけ** 選ぶ。アクティブなものを優先する
 * （ユーザーが見ている画面で操作が起きる方が、何が起きたか分かる）。
 *
 * 【なぜ全タブに送らないのか】
 * 2 枚に送ると、片方がミュートした直後にもう片方が古い DOM で同じ項目を押す。
 * **項目はトグルなので解除される。**1 枚に限定すればこの経路が原理的に消える。
 *
 * chrome.tabs.query の url フィルタは tabs 権限を必要としない。
 * host_permissions が一致していれば効き、tab.url も返る。
 */
async function findTrendTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ url: QIITA_TAB_PATTERN });
  const trend = tabs.filter((tab) => tab.id !== undefined && isTrendTabUrl(tab.url));
  return (trend.find((tab) => tab.active) ?? trend[0])?.id ?? null;
}

/**
 * 別コンテキストから来る値。型アサーションではなく型ガードで受ける
 * （content-script の isPongResponse と同じ思想）。
 * handle まで照合するのは、別の依頼の応答を取り違えないため。
 */
function isMuteResult(
  value: unknown,
  handle: AccountHandle,
): value is Extract<QtgResponse, { type: 'MUTE_RESULT' }> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<{ type: unknown; handle: unknown; outcome: unknown }>;
  return (
    candidate.type === 'MUTE_RESULT' &&
    candidate.handle === handle &&
    isMuteOutcome(candidate.outcome)
  );
}

async function sendMuteRequest(handle: AccountHandle): Promise<MuteOutcome> {
  const tabId = await findTrendTabId();
  if (tabId === null) return 'no-trend-tab';
  try {
    const request: QtgRequest = { type: 'MUTE_AUTHOR', handle };
    const response: unknown = await chrome.tabs.sendMessage(tabId, request);
    return isMuteResult(response, handle) ? response.outcome : 'unreachable';
  } catch {
    // 拡張をリロードすると、開きっぱなしのタブの content script が孤児になる。
    // ユーザーの操作どおりの結果であって不具合ではない
    return 'unreachable';
  }
}

/**
 * ミュートを依頼し、結果を記録して **更新後の全体を返す**（saveVerdict と同じ形）。
 *
 * **storage.onChanged で起動しない。**評価が既に valid なら値が変わらず通知が
 * 発火せず、押し直しでのやり直しができなくなる。ミュートは状態ではなく操作である。
 * この経路にしてあるおかげで、**失敗したらもう一度「妥当」を押せばやり直せる** —
 * 専用のリトライ機構を持たずに済む。
 */
export async function requestMute(handle: AccountHandle, now: Date): Promise<MuteLog> {
  return storage.recordMuteOutcome(handle, await sendMuteRequest(handle), now);
}

/**
 * トレンド外の候補では**依頼を送らず**、`not-on-page` として記録する。
 * （2026-09-17 ユーザー「A で直して」）
 *
 * 【なぜ送らないのか】
 * スナップショットに居ない著者のカードは表示中のページに無いので、送っても
 * content script が `not-on-page` を返すだけ。**送ると結果の文言がずれる** —
 * トレンドのタブを閉じていれば `no-trend-tab`（「トレンドページを開いてから
 * 押してください」）になるが、開いても著者は居ないので押し直しは効かない。
 *
 * 【スナップショットが古くても取りこぼさない】
 * 送らなかった著者があとから読み込んだトレンドに居れば、記録より新しい
 * スナップショットに現れるので {@link isMuteRetryReady} が拾う。
 *
 * recordMuteOutcome を通すので、確認済みの `mutedAt` は消えない。
 */
export async function skipMute(handle: AccountHandle, now: Date): Promise<MuteLog> {
  return storage.recordMuteOutcome(handle, 'not-on-page', now);
}
