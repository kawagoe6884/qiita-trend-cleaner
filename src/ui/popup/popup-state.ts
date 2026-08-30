/**
 * ポップアップの状態と文言を作る。
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
import { RATE_LIMIT_ANON, RATE_LIMIT_AUTH } from '../../api/rate-budget';
import { isTrendPage } from '../../dom/trend-reader';
import { isMuteOutcome, BURST_WINDOW_CHOICES } from '../../types/domain';
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
  Verdict,
} from '../../types/domain';
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
   * 最後にミュートを試みた結果。**試していなければ null。**
   *
   * 「まだ試していない」と「試して失敗した」を取り違えると、ユーザーは
   * 押し直すべきかどうかが分からなくなる（適合率の分母 0 を 0% にしないのと同じ話）。
   */
  mute: MuteRecord | null;
}

/**
 * 候補に判定・根拠リンク・ミュートの結果を重ねる。Candidate 自体は変更しない。
 *
 * muteLog を省略できるようにしてあるのは、ミュートを使わない呼び出し
 * （Phase 6 からの経路）を書き換えずに済ませるため。
 */
export function toViews(
  candidates: Candidate[],
  feedback: FeedbackLog,
  muteLog: MuteLog = {},
): CandidateView[] {
  return candidates.map((candidate) => ({
    candidate,
    verdict: feedback[candidate.authorHandle] ?? null,
    evidence: candidate.sharedItemIds.map((itemId) => ({
      itemId,
      url: `https://qiita.com/${candidate.authorHandle}/items/${itemId}`,
    })),
    mute: muteLog[candidate.authorHandle] ?? null,
  }));
}

export interface PartitionedViews {
  open: CandidateView[];
  folded: CandidateView[];
}

/**
 * 折りたたむものと出すものに分ける。**純粋関数。順序は保つ。**
 *
 * 【mutedAt で見る。outcome では見ない】
 * ミュートすると Qiita がその著者の記事をトレンドから外すので、押し直すと
 * 必ず `not-on-page` になる（MuteRecord.mutedAt の JSDoc）。outcome で
 * 判定すると、**押し直した瞬間に折りたたみから飛び出す。**
 *
 * 【'muted' では「誤り」を押しても外れない】
 * 「誤り」を押しても Qiita 側のミュートは解除されない。折りたたみに残るのは
 * 事実として正しい。解除の導線は foldNote が出す。
 */
export function partitionViews(views: CandidateView[], target: FoldTarget): PartitionedViews {
  const shouldFold = (view: CandidateView): boolean => {
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
 * 折りたたみの見出し。**0 件なら空文字を返し、器ごと出さない**
 * （describeCoAuthors と同じ規約）。
 */
export function describeFold(target: FoldTarget, count: number): string {
  if (target === 'none' || count === 0) return '';
  const label =
    target === 'muted' ? 'ミュート済み' : target === 'valid' ? '「妥当」と評価した' : '評価済み';
  return `${label} ${String(count)} 件`;
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
 * 候補の一覧に添える一言。
 *
 * 数字だけを並べると、**何を求められているのかが伝わらない。**
 * 適合率はユーザーが「妥当 / 誤り」を押さない限り永久に出ないので、
 * 押してほしいことをこちらから言う。それが唯一の指標の入力経路である。
 *
 * 【何に対する判断かを必ず書く】
 * 評価する対象は **検出そのもの**（当たっていたか）であって、著者の人格ではない。
 * それを書かずに「妥当 / 誤り」とだけ出すと、何を訊かれているのか分からない。
 * 「不正」「スパム」と断定しないこと（設計上の約束 6）とは別の話で、
 * **断定しないことと、何を訊いているか言わないことは違う。**
 */
export function describeCall(views: CandidateView[], precision: Precision): string {
  if (views.length === 0) return '';
  if (precision.ratio === null) {
    return 'この検出が当たっているか、根拠の記事を読んで「妥当 / 誤り」で記録してください。';
  }
  const unjudged = views.filter((view) => view.verdict === null).length;
  if (unjudged > 0) return `未評価があと ${String(unjudged)} 件あります。`;
  return 'この一覧はすべて評価済みです。';
}

/**
 * 同じクラスタが現れた他の著者の案内。**無ければ空文字を返し、行ごと出さない。**
 *
 * 根拠記事はこの著者のぶんしか持たない（popup-state が根拠 URL を
 * authorHandle から組み立てるため）。他の著者の記事を見たければ、その著者の
 * 候補を開けば根拠リンクがある。
 *
 * **断定しない**（設計上の約束 6）。「組織票」「不正」とは書かない。
 */
export function describeCoAuthors(coAuthors: AccountHandle[] | undefined): string {
  if (coAuthors === undefined || coAuthors.length === 0) return '';
  return `同じメンバーが ${coAuthors.join('、')} の記事にも現れています。`;
}

/**
 * 候補ゼロのときの案内。**原因が 2 つあるので言い分ける。**
 *
 * 蓄積がまだ無いのか、蓄積はあるが条件が厳しいのかで、次にやることが違う。
 * 1 つの文言にすると、スライダーを上げてゼロになった人に
 * 「トレンドページを開いてください」と的外れな案内を出すことになる。
 */
export function describeEmpty(hasIndex: boolean, foldedCount = 0): string {
  // 折りたたみの中に居るのに「条件をゆるめると増えます」と言うと、
  // 何もしていない人に条件をいじらせることになる。**原因は 3 つある**
  if (foldedCount > 0) return '出ている候補はすべて折りたたみの中にあります。';
  return hasIndex
    ? 'いまの条件に当てはまる候補はありません。条件をゆるめると増えます。'
    : 'まだ何も集めていません。トレンドページを開くと蓄積が始まります。';
}

const MINUTES_PER_DAY = 60 * 24;

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

/** 幅の表示。1 日以上は日で言う（「1440 分」は読めない） */
export function describeWindow(minutes: number): string {
  if (minutes >= MINUTES_PER_DAY && minutes % MINUTES_PER_DAY === 0) {
    return `${String(minutes / MINUTES_PER_DAY)} 日`;
  }
  return `${String(minutes)} 分`;
}

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

/** 0.0-1.0 を百分率の整数にする。0.98 → 98 */
function toPercent(ratio: number): string {
  return String(Math.round(ratio * 100));
}

/**
 * 窓内占有率の行。**候補 1 件の見出しになる数字。**
 *
 * 【burstScore を画面から降ろした】
 * `burstScore` は「**クラスタのいいね**のうち窓内だったもの」で、彼らが早く
 * 押したかしか言わない。実測（2026-08-25）では、どの幅でも 80〜95% の著者と、
 * 180 分で 79% ／ 2 日で 43% まで薄まる著者を **burstScore では区別できなかった**。
 * 分けたのは占有率だけだった。並び順のタイブレークには引き続き使う。
 *
 * 【実件数を書く】
 * 「100%」は 10/10 とも 5/5 とも読める。％だけにすると強さが読めない。
 *
 * 【3 つの状態を言い分ける】
 *   - null      … **測れない**（いいねの多い記事を含み、分母が欠けている）
 *   - total = 0 … 測ったが窓内にいいねが無かった
 *   - それ以外  … 件数と割合
 * 「測れない」と「測ったら 0 だった」を混ぜると、条件を動かす方向が逆になる
 * （適合率の分母 0 を 0% にしないのと同じ話）。
 */
export function describeWindowShare(candidate: Candidate, windowMinutes: number): string {
  // **「該当記事の」を付ける。**見出しが「3 記事に重なった」と言っているので、
  // どの記事の話かをこの行だけで読めるようにする
  const scope = `該当記事の投稿から ${describeWindow(windowMinutes)}以内`;
  // 保存済みの古い候補にはこのフィールドが無い。undefined も「測れない」に倒す
  const share = candidate.windowShare ?? null;
  if (share === null) return `${scope}の占有率は測れません (いいねの多い記事を含みます)`;
  if (share.total === 0) return `${scope}にいいねした人はまだいません`;
  const ratio = toPercent(share.cluster / share.total);
  return `${scope}にいいねした ${String(share.cluster)}/${String(share.total)} アカウント (${ratio}%) が同じメンバー`;
}

export interface ModeCopy {
  title: string;
  detail: string;
  action: string;
}

/**
 * 動作モードの説明。**トークンそのものは扱わず、有無だけを受ける。**
 * 枠の数値は rate-budget の定数から作り、UI に直書きしない。
 */
export function describeMode(hasToken: boolean): ModeCopy {
  if (hasToken) {
    return {
      title: 'フルモードで動作中',
      detail: `著者の過去記事まで辿ります。1 時間あたり ${String(RATE_LIMIT_AUTH)} リクエストまで使えます。`,
      action: 'トークンを変更する',
    };
  }
  // 枠の広さより先に「判定材料が揃わない」ことを言う。実測では 27 記事中、
  // 同じ著者の記事に同じ人が重ねていいねした組が上位に 1 つも無かった。
  // **断定はしない**（約束 6）。ライトでも検出できる場合はある
  return {
    title: 'ライトモードで動作中',
    detail: `いま画面に出ている記事だけを見ます。同じ著者の記事が複数トレンドに出ていないと判定材料が揃いません。トークンを設定すると著者の過去記事まで辿れ、1 時間あたりの枠も ${String(RATE_LIMIT_ANON)} → ${String(RATE_LIMIT_AUTH)} リクエストに広がります。`,
    action: 'トークンを設定する',
  };
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
  /** 「妥当」と同時に Qiita 側でもミュートするか。**既定は false** */
  muteOnValid: boolean;
  /** 評価が済んだ候補を折りたたむ対象。**既定は 'none'** */
  foldTarget: FoldTarget;
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
  ]);
  return {
    views: toViews(candidates, feedback, muteLog),
    precision: precisionOf(feedback),
    settings,
    rateLimitNotice: rateLimitNotice(until, now),
    lastScanAt: lastScan?.finishedAt ?? null,
    hasToken,
    hasIndex: Object.keys(index).length > 0,
    muteOnValid,
    foldTarget,
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
  // 消える**（Candidate.verdict を持たせなかったのと同じ形の失敗）
  const [index, feedback, muteLog] = await Promise.all([
    storage.getLikeIndex(),
    storage.getFeedback(),
    storage.getMuteLog(),
  ]);
  const candidates = detectCandidates(index, settings, now);
  await storage.saveSettings(settings);
  await storage.saveCandidates(candidates);
  return toViews(candidates, feedback, muteLog);
}

/**
 * 保存は ISO 8601（UTC）だが、読む人は JST で暮らしている。
 * timeZone を明示するので、実行環境のタイムゾーンに依存しない。
 */
export function formatJst(iso: IsoDateTime): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
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
 * 記録 1 件の文言。**成功したことがあるかどうかで言い方を変える。**
 *
 * 【なぜ outcome だけでは足りないのか】
 * **ミュートすると Qiita がその著者の記事をトレンドから外す**（2026-08-24 実機）。
 * そのあと同じ候補で「妥当」を押し直すと、カードが無いので `not-on-page` になる。
 * outcome だけを見ると「次に出てきたときに押し直してください」と案内してしまうが、
 * **ミュート済みの著者はもう出てこない。**起こり得ないことを促す文言だった。
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
  if (record.outcome === 'not-on-page') {
    return 'ミュート済みです。ミュートした著者の記事はトレンドから外れるので、ここには出てきません。';
  }
  return describeMuteOutcome(record.outcome);
}

/**
 * 結果ごとの文言。**断定しない**（設計上の約束 6）。
 *
 * 成功の記録がある場合の言い換えは describeMuteRecord が行う。ここは
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
      return 'いま開いているトレンドページにこの著者の記事が無いため、ミュートできませんでした。次に出てきたときに押し直してください。';
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
