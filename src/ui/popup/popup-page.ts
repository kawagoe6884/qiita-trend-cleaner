/**
 * ポップアップの DOM 配線。
 *
 * 状態と文言の決定は popup-state.ts にある。
 * ここは「状態を DOM に映す」ことと「イベントを流す」ことだけを行う。
 * 要素が取れなければ何もしない（selectors.ts と同じフェイルセーフ原則）。
 *
 * 【innerHTML を使わない】
 * 著者ハンドルも記事 ID も Qiita 由来の外部データである。textContent と
 * createElement だけで組む。Phase 7 で XSS を再評価する前に穴を作らない。
 *
 * 【リスナーはイベント委譲にする】
 * 閾値を動かすたびに候補の要素を作り直すため、個々のボタンに付けた
 * リスナーは消える。一覧のコンテナで受けること。
 */
import { logger } from '../../lib/logger';
import { updateBadge } from '../../lib/badge';
import {
  loadPopupState,
  applySettings,
  recordVerdict,
  formatJst,
  describeMode,
  describeCall,
  describeEmpty,
  rateLimitNotice,
} from './popup-state';
import type { CandidateView, Precision } from './popup-state';
import { DEFAULT_SETTINGS } from '../../types/domain';
import type { Settings, Verdict } from '../../types/domain';

const SELECTORS = {
  notice: '#notice',
  modeTitle: '#mode-title',
  modeDetail: '#mode-detail',
  summary: '#summary',
  call: '#call',
  lastScan: '#last-scan',
  candidates: '#candidates',
  empty: '#empty',
  minCluster: '#min-cluster',
  minShared: '#min-shared',
  lookback: '#lookback',
  minClusterValue: '#min-cluster-value',
  minSharedValue: '#min-shared-value',
  lookbackValue: '#lookback-value',
  conditionsSummary: '#conditions-summary',
  openOptions: '#open-options',
} as const;

/** スライダーの可動域。実測（最大クラスタ 16）と保持期間 7 日に合わせる */
const RANGES = {
  minClusterSize: { min: 2, max: 30 },
  minSharedItems: { min: 2, max: 10 },
  lookbackDays: { min: 1, max: 7 },
} as const;

function find<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

/**
 * 判定の保存中フラグ。
 * 連打すると同じ判定が二重に走り、後から解決した側が古い適合率を描く。
 */
let busy = false;

function setText(selector: string, text: string): void {
  const element = find(selector);
  if (element) element.textContent = text;
}

function setHidden(selector: string, hidden: boolean): void {
  const element = find(selector);
  if (element) element.hidden = hidden;
}

/** 適合率。分母 0 は「—」。0% と区別する */
function formatPrecision(precision: Precision): string {
  if (precision.ratio === null) return '適合率 —（未評価）';
  const percent = Math.round(precision.ratio * 100);
  return `適合率 ${String(percent)}%（妥当 ${String(precision.valid)} / 誤り ${String(precision.falsePositive)}）`;
}

/**
 * 動作モードとトークンの案内。**候補より上に出す。**
 * 下に置くと「なぜトークンを設定するのか」が候補の後ろに埋もれ、
 * 429 に当たってから初めて存在に気づくことになる。
 */
function renderMode(hasToken: boolean): void {
  const copy = describeMode(hasToken);
  setText(SELECTORS.modeTitle, copy.title);
  setText(SELECTORS.modeDetail, copy.detail);
  setText(SELECTORS.openOptions, copy.action);
}

function renderSummary(views: CandidateView[], precision: Precision): void {
  setText(SELECTORS.summary, `候補 ${String(views.length)} 件 / ${formatPrecision(precision)}`);
  const call = describeCall(views, precision);
  setText(SELECTORS.call, call);
  setHidden(SELECTORS.call, call === '');
  setText(SELECTORS.empty, describeEmpty(currentHasIndex));
  setHidden(SELECTORS.empty, views.length > 0);
  // バッジはスキャン時だけでなく、閾値を変えたときも合わせる。
  // 合わせないと一覧が 5 件を出しているのにバッジは前回の 2 件を出し続ける
  void updateBadge(views.length, currentRateLimited);
}

/** 断定しない（設計上の約束 6）。「不正」「スパム」とは書かない */
function describeCandidate(view: CandidateView): string {
  const { clusterSize, sharedItemCount } = view.candidate;
  return `${String(clusterSize)} アカウントが ${String(sharedItemCount)} 記事に共通`;
}

function describeScores(view: CandidateView): string {
  const { burstScore, emptyAccountRatio } = view.candidate;
  return `投稿直後の集中 ${burstScore.toFixed(2)} / 空アカウント ${emptyAccountRatio.toFixed(2)}`;
}

function paragraph(className: string, text: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = text;
  return element;
}

/** 根拠記事へのリンク。これが無いと「妥当 / 誤り」が当てずっぽうになる */
function evidenceLine(view: CandidateView): HTMLParagraphElement {
  const line = paragraph('evidence', '根拠: ');
  view.evidence.forEach((item, index) => {
    const link = document.createElement('a');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = `記事 ${String(index + 1)}`;
    line.append(link, ' ');
  });
  return line;
}

function verdictButton(
  label: string,
  verdict: Verdict,
  current: Verdict | null,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.verdict = verdict;
  button.textContent = label;
  button.setAttribute('aria-pressed', String(current === verdict));
  return button;
}

function candidateItem(view: CandidateView): HTMLLIElement {
  const item = document.createElement('li');
  // ハンドルは外部データ。dataset に入れるだけで HTML として解釈させない
  item.dataset.handle = view.candidate.authorHandle;
  const actions = document.createElement('p');
  actions.className = 'actions';
  actions.append(
    verdictButton('妥当', 'valid', view.verdict),
    verdictButton('誤り', 'false_positive', view.verdict),
  );
  item.append(
    paragraph('author', view.candidate.authorHandle),
    paragraph('stats', describeCandidate(view)),
    paragraph('scores', describeScores(view)),
    evidenceLine(view),
    actions,
  );
  return item;
}

function renderCandidates(views: CandidateView[]): void {
  const list = find<HTMLUListElement>(SELECTORS.candidates);
  if (!list) return;
  list.replaceChildren(...views.map(candidateItem));
}

/** 折りたたんだままでも現在の条件が読めるようにする */
function describeConditions(settings: Settings): string {
  return `判定の条件（${String(settings.minClusterSize)} アカウントが ${String(settings.minSharedItems)} 記事に共通 / 直近 ${String(settings.lookbackDays)} 日）`;
}

/**
 * スライダーの可動域と初期値。**init でだけ呼ぶ。**
 *
 * ドラッグ中に value を書き戻すと、つまみと入力が競合しうる。表示の更新は
 * renderSettingLabels に分ける。
 *
 * ただし **この分離はテストで守られていない。** 書き戻す値は直前に同じ入力から
 * 読んだ値なので、jsdom では書き戻しても観測差が出ない（変異を入れても落ちない
 * ことを確認済み）。実際につまみが逃げる原因は index.html の要素順序であり、
 * そちらは popup-page.test.ts が実ファイルに対して固定している。
 */
function renderSliderInputs(settings: Settings): void {
  const bind = (selector: string, value: number, range: { min: number; max: number }): void => {
    const input = find<HTMLInputElement>(selector);
    if (!input) return;
    input.min = String(range.min);
    input.max = String(range.max);
    input.value = String(value);
  };
  bind(SELECTORS.minCluster, settings.minClusterSize, RANGES.minClusterSize);
  bind(SELECTORS.minShared, settings.minSharedItems, RANGES.minSharedItems);
  bind(SELECTORS.lookback, settings.lookbackDays, RANGES.lookbackDays);
}

/** 数値表示と折りたたみの見出し。ドラッグ中も呼ぶので input には触らない */
function renderSettingLabels(settings: Settings): void {
  setText(SELECTORS.minClusterValue, String(settings.minClusterSize));
  setText(SELECTORS.minSharedValue, String(settings.minSharedItems));
  setText(SELECTORS.lookbackValue, String(settings.lookbackDays));
  setText(SELECTORS.conditionsSummary, describeConditions(settings));
}
/**
 * スライダーの現在値。要素が取れなければ直前の値の側に倒す。
 *
 * **可動域に丸める。** RANGES は renderSliderInputs で min/max に流し込んで
 * いるが、それは HTML 側の制約でしかない。丸めておかないと、HTML の max を
 * 変えて RANGES を直し忘れたときや DOM を直接いじられたときに、
 * 範囲外の値がそのまま storage.sync に入る。
 */
function readSettings(fallback: Settings): Settings {
  const read = (selector: string, current: number, range: { min: number; max: number }): number => {
    const input = find<HTMLInputElement>(selector);
    const parsed = input === null ? Number.NaN : Number(input.value);
    if (!Number.isInteger(parsed) || parsed <= 0) return current;
    return Math.min(Math.max(parsed, range.min), range.max);
  };
  return {
    minClusterSize: read(SELECTORS.minCluster, fallback.minClusterSize, RANGES.minClusterSize),
    minSharedItems: read(SELECTORS.minShared, fallback.minSharedItems, RANGES.minSharedItems),
    lookbackDays: read(SELECTORS.lookback, fallback.lookbackDays, RANGES.lookbackDays),
  };
}

/**
 * change の連打をまとめる遅延（ミリ秒）。
 *
 * マウスなら change は「離したとき 1 回」だが、**キーボードの矢印キーは
 * リピートのたびに発火する**（押しっぱなしで毎秒数十回）。
 * 1 回ごとに storage 全体の読み込みと検出が走り、sync への保存も走るため
 * （sync は 1800 writes/hour）、束ねないとマウスで踏んだのと同じ問題が
 * キーボードで再発する。
 */
const APPLY_DEBOUNCE_MS = 250;

/** 直近に描いた状態。再検出せずに済む更新のために持つ */
let currentSettings: Settings = DEFAULT_SETTINGS;
let currentPrecision: Precision = { valid: 0, falsePositive: 0, ratio: null };
let currentViews: CandidateView[] = [];
let currentHasIndex = false;
let currentRateLimited = false;

/**
 * ドラッグ中に呼ぶ。**同期処理だけ。**
 *
 * storage も検出も一覧の再構築もしない。ここに非同期を 1 つでも足すと、
 * 1 px 動かすたびの input で storage 全体の読み込みと 300 アカウント分の
 * 検出が走り、描画スレッドが飽和して **つまみがドラッグに追従しなくなる**。
 */
function previewSettings(): Settings {
  currentSettings = readSettings(currentSettings);
  renderSettingLabels(currentSettings);
  return currentSettings;
}

/** つまみを離したとき（change）に呼ぶ。ここで初めて保存と再検出をする */
async function applyCurrentSettings(): Promise<void> {
  const settings = previewSettings();
  currentViews = await applySettings(settings, new Date());
  renderCandidates(currentViews);
  renderSummary(currentViews, currentPrecision);
}

let applyTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 実行中の適用。**直列につなぐ。**
 *
 * デバウンスは「保留中のタイマー」しか束ねない。タイマーが発火した瞬間に
 * applyTimer は null に戻るため、それだけでは **実行中の適用が次の適用を
 * 止められない**。applySettings は storage 全体を 2 回読んで検出を回し、
 * さらに sync と local へ書くので、重なると二重に走り、
 * 後から解決した側が古い設定で上書きしうる。
 *
 * つないでおけば、次の適用は前が終わってから始まる。**最後に走ったものが
 * 最後に書く**ことが順序として保証され、そのとき読むスライダーの値も最新になる。
 * 兄弟の handleVerdict が busy フラグで防いでいるのと同じ危険。
 */
let applyChain: Promise<void> = Promise.resolve();

/** 最後の change から一定時間おいてから 1 度だけ適用する */
function scheduleApply(): void {
  if (applyTimer !== null) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    applyChain = applyChain
      .then(() => applyCurrentSettings())
      .catch((error: unknown) => {
        logger.error('failed to apply settings:', error);
      });
  }, APPLY_DEBOUNCE_MS);
}

/**
 * 判定を記録する。
 *
 * 閾値は変わらないので **検出はやり直さない。** 手元の views を差し替えるだけ。
 * ここで applySettings を呼ぶと、ボタン 1 回ごとに storage 全体の読み込みが走る。
 */
async function handleVerdict(handle: string, verdict: Verdict): Promise<void> {
  // 連打すると後から解決した側が古い適合率を描く
  if (busy) return;
  busy = true;
  try {
    currentPrecision = await recordVerdict(handle, verdict);
    currentViews = currentViews.map((view) =>
      view.candidate.authorHandle === handle ? { ...view, verdict } : view,
    );
    renderCandidates(currentViews);
    renderSummary(currentViews, currentPrecision);
  } finally {
    busy = false;
  }
}

/** クリックされたボタンから著者と判定を取り出す。委譲なので自分で辿る */
function resolveVerdictTarget(
  target: EventTarget | null,
): { handle: string; verdict: Verdict } | null {
  if (!(target instanceof Element)) return null;
  const button = target.closest<HTMLButtonElement>('button[data-verdict]');
  const item = target.closest<HTMLLIElement>('li[data-handle]');
  const verdict = button?.dataset.verdict;
  const handle = item?.dataset.handle;
  if (handle === undefined || (verdict !== 'valid' && verdict !== 'false_positive')) return null;
  return { handle, verdict };
}

/**
 * 根拠記事を **背景タブ** に開く。
 *
 * ポップアップは他所にフォーカスが移った時点で閉じる。リンクを普通に開くと
 * 判定ボタンを押す前に閉じてしまい、記事 1 本ごとにポップアップを開き直す
 * ことになる。背景タブなら開いたままなので、根拠をまとめて開いてから
 * 読みに行き、戻って判定できる。
 *
 * タブを作るだけなら tabs 権限は要らない（URL やタイトルの読み取りには要る）。
 */
function openInBackground(url: string): void {
  chrome.tabs.create({ url, active: false }).catch((error: unknown) => {
    logger.error('failed to open evidence:', error);
  });
}

/**
 * 429 の状態を storage の変更から追う。**init のスナップショットだけでは足りない。**
 *
 * ポップアップは開いたまま数分生きる。その間に別タブでトレンドページを開けば
 * スキャンが走り、429 に達すれば service worker がバッジを「!」にする。
 * ところがポップアップ側は init 時点の「429 ではない」を握ったままなので、
 * **スライダーを 1 つ動かした瞬間に候補件数でバッジを上書きし、「!」を消す。**
 * ユーザーは枠切れに気づく手段を失う。
 *
 * storage を読み直すのではなく変更通知を使うのは、getRateLimitedUntil が
 * storage 全体を読むため。スライダーの操作ごとに呼ぶと Phase 6 で潰した
 * 描画詰まりが戻る。
 */
function watchRateLimit(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('rateLimitedUntil' in changes)) return;
    const until: unknown = changes.rateLimitedUntil.newValue;
    const notice = rateLimitNotice(typeof until === 'number' ? until : null, new Date());
    currentRateLimited = notice !== null;
    setText(SELECTORS.notice, notice ?? '');
    setHidden(SELECTORS.notice, notice === null);
    void updateBadge(currentViews.length, currentRateLimited);
  });
}

/**
 * イベントリスナーを登録する。
 *
 * **storage の読み込みより先に呼ぶこと。**（options-page.ts と同じ理由）
 * 一覧のリスナーはコンテナに付ける。候補の要素は再検出のたびに作り直されるため、
 * 個々のボタンに付けると 2 回目以降のクリックが効かなくなる。
 */
function attachListeners(): void {
  watchRateLimit();
  find(SELECTORS.candidates)?.addEventListener('click', (event) => {
    const link =
      event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (link !== null) {
      event.preventDefault();
      openInBackground(link.href);
      return;
    }
    const resolved = resolveVerdictTarget(event.target);
    if (resolved === null) return;
    handleVerdict(resolved.handle, resolved.verdict).catch((error: unknown) => {
      logger.error('failed to record verdict:', error);
    });
  });

  for (const selector of [SELECTORS.minCluster, SELECTORS.minShared, SELECTORS.lookback]) {
    const input = find<HTMLInputElement>(selector);
    // input はドラッグ中に連続発火する。数字の表示だけを同期で更新する
    input?.addEventListener('input', () => {
      previewSettings();
    });
    // change はマウスなら離したとき 1 回だが、キーリピートでは連続して来る
    input?.addEventListener('change', () => {
      scheduleApply();
    });
  }

  find(SELECTORS.openOptions)?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage().catch((error: unknown) => {
      logger.error('failed to open options page:', error);
    });
  });
}

/**
 * ポップアップを初期化する。
 * 状態の読み込みに失敗しても、リスナーだけは必ず付いた状態にする。
 */
export async function init(): Promise<void> {
  attachListeners();
  try {
    const state = await loadPopupState(new Date());
    currentSettings = state.settings;
    currentPrecision = state.precision;
    currentViews = state.views;
    currentHasIndex = state.hasIndex;
    currentRateLimited = state.rateLimitNotice !== null;
    renderMode(state.hasToken);
    renderSliderInputs(state.settings);
    renderSettingLabels(state.settings);
    renderCandidates(state.views);
    renderSummary(state.views, state.precision);
    setText(
      SELECTORS.lastScan,
      state.lastScanAt === null
        ? 'まだスキャンしていません'
        : `最終スキャン ${formatJst(state.lastScanAt)}`,
    );
    setText(SELECTORS.notice, state.rateLimitNotice ?? '');
    setHidden(SELECTORS.notice, state.rateLimitNotice === null);
  } catch (error) {
    logger.error('failed to load popup state:', error);
    setText(SELECTORS.summary, '読み込みに失敗しました。開き直してください。');
  }
}
