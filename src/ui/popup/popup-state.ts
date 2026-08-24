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
import { isMuteOutcome } from '../../types/domain';
import type {
  AccountHandle,
  Candidate,
  FeedbackLog,
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
   * Phase 9 は適合率 80% を目標に閾値を追い込むフェーズなので、
   * この 2 つを取り違えると調整の方向が逆になる。
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
  return `同じ顔ぶれが ${coAuthors.join('、')} の記事にも現れています。`;
}

/**
 * 候補ゼロのときの案内。**原因が 2 つあるので言い分ける。**
 *
 * 蓄積がまだ無いのか、蓄積はあるが条件が厳しいのかで、次にやることが違う。
 * 1 つの文言にすると、スライダーを上げてゼロになった人に
 * 「トレンドページを開いてください」と的外れな案内を出すことになる。
 */
export function describeEmpty(hasIndex: boolean): string {
  return hasIndex
    ? 'いまの条件に当てはまる候補はありません。条件をゆるめると増えます。'
    : 'まだ何も集めていません。トレンドページを開くと蓄積が始まります。';
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
}

/** 保存済みの状態をまとめて読む */
export async function loadPopupState(now: Date): Promise<PopupState> {
  const [candidates, feedback, settings, until, lastScan, hasToken, index, muteOnValid, muteLog] =
    await Promise.all([
      storage.getCandidates(),
      storage.getFeedback(),
      storage.getSettings(),
      storage.getRateLimitedUntil(),
      storage.getLastScanResult(),
      storage.hasToken(),
      storage.getLikeIndex(),
      storage.getMuteOnValid(),
      storage.getMuteLog(),
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
 * `menu-unavailable` も同じで、成功の記録があるなら「既にミュート済み」と
 * 言い切ってよい（推測混じりの「〜か、画面構造が変わった可能性」にしない）。
 */
export function describeMuteRecord(record: MuteRecord): string {
  if (record.mutedAt === undefined) return describeMuteOutcome(record.outcome);
  if (record.outcome === 'not-on-page' || record.outcome === 'menu-unavailable') {
    return 'ミュート済みです。ミュートした著者の記事はトレンドから外れるので、ここには出てきません。設定 > ミュート で確認・解除できます。';
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
    case 'not-on-page':
      return 'いま開いているトレンドページにこの著者の記事が無いため、ミュートできませんでした。次に出てきたときに押し直してください。';
    case 'no-trend-tab':
      return 'トレンドページを開いてから押してください。';
    case 'menu-unavailable':
      return 'ミュートのメニューが見つかりませんでした。既にミュート済みか、Qiita の画面構造が変わった可能性があります。';
    case 'timeout':
      return '完了の通知を確認できませんでした。設定 > ミュート で結果を確認してください。';
    case 'unreachable':
      return 'トレンドページに届きませんでした。ページを再読み込みしてから押し直してください。';
  }
}
