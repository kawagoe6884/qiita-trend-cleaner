/**
 * options ページの DOM 配線。
 *
 * 状態遷移とメッセージ決定は token-form.ts にある。
 * ここは「状態を DOM に映す」ことと「イベントを流す」ことだけを行う。
 * 要素が取れなければ何もしない（selectors.ts と同じフェイルセーフ原則）。
 *
 * 【エントリと分けている理由】
 * main.ts がトップレベルで実行するとテストから呼べない。
 * init() を export してここに置くことで、「storage が失敗しても submit
 * リスナーが付く」ような構造的な性質を jsdom で固定できる。
 */
import { logger } from '../../lib/logger';
import { loadState, submitToken, removeToken, describeMode } from './token-form';
import type { TokenState } from './token-form';
import {
  getMuteOnValid,
  saveMuteOnValid,
  getFoldTarget,
  saveFoldTarget,
  getAiHintPrefs,
  saveAiHintPrefs,
  getAiVerdicts,
} from '../../lib/storage';
import { agreementAt, agreementByThreshold, countLegacyAnswers } from '../../detect/ai-agreement';
import {
  describeAgreementCell,
  describeAgreementSummary,
  describeLegacy,
} from './ai-agreement-copy';
import {
  AI_HINT_MIN_PROSE_RANGE,
  AI_HINT_THRESHOLD_RANGE,
  DEFAULT_AI_HINT_PREFS,
  isFoldTarget,
  isIntInRange,
} from '../../types/domain';
import type { AiHintPrefs, AiVerdictLog } from '../../types/domain';

/**
 * このページが触る DOM セレクタ。
 * find() はフェイルセーフで null を返すため、片方をタイポしても
 * 例外は出ず「無言で更新されない」だけになる。定数に集約して分岐を防ぐ。
 */
const SELECTORS = {
  form: '#token-form',
  token: '#token',
  save: '#save',
  remove: '#remove',
  modeTitle: '#mode-title',
  modeDetail: '#mode-detail',
  saved: '#saved',
  masked: '#masked',
  message: '#message',
  muteOnValid: '#mute-on-valid',
  muteOnValidState: '#mute-on-valid-state',
  foldTarget: 'input[name="fold-target"]',
  aiThreshold: '#ai-threshold',
  aiThresholdValue: '#ai-threshold-value',
  aiMinProse: '#ai-min-prose',
  aiMinProsePresets: 'button[data-min-prose]',
  aiAgreementSummary: '#ai-agreement-summary',
  aiAgreementRows: '#ai-agreement-rows',
  aiAgreementLegacy: '#ai-agreement-legacy',
} as const;

/**
 * トグルの状態の文言。**色だけで状態を伝えない。**
 *
 * 色覚や表示環境（強制カラー・モノクロ印刷）では色の差が届かない。
 * つまみの移動も 20px でしかなく、一目では読み取りにくい。
 */
const TOGGLE_STATE_TEXT = { on: 'する', off: 'しない' } as const;

export function describeToggleState(checked: boolean): string {
  return checked ? TOGGLE_STATE_TEXT.on : TOGGLE_STATE_TEXT.off;
}

/** 想定外の失敗で出す文言。ハンドラ側とリスナー側の 2 箇所で使うため定数にする */
const UNEXPECTED_SUBMIT_ERROR = '予期しないエラーが発生しました。ページを再読み込みしてください。';
const UNEXPECTED_REMOVE_ERROR = '削除できませんでした。ページを再読み込みしてください。';

function find<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

/**
 * 送信・削除の実行中フラグ。
 *
 * 保存ボタンだけを無効にしても入力欄は編集できるため、検証の往復中に
 * ユーザーが打ち直すと、先に投げた（古い）呼び出しが成功したときに
 * clearInput() が**まだ送っていない入力**を消してしまう。
 * 送信と削除が同時に走って互いの描画を上書きする問題も同じ根による。
 */
let busy = false;

/**
 * 操作中の入力を止める。
 * 入力欄は disabled ではなく readOnly にする（disabled はフォーカスを奪うため）。
 */
function setBusy(next: boolean): void {
  busy = next;

  const input = find<HTMLInputElement>(SELECTORS.token);
  if (input) input.readOnly = next;

  const save = find<HTMLButtonElement>(SELECTORS.save);
  if (save) save.disabled = next;

  const remove = find<HTMLButtonElement>(SELECTORS.remove);
  if (remove) remove.disabled = next;
}

/**
 * モード表示には触れず、メッセージだけを出す。
 * 保存状態が分からない場面で「ライトモード」などと断定しないための出口。
 */
function showMessage(text: string): void {
  const message = find(SELECTORS.message);
  if (message) message.textContent = text;
}

/**
 * モード表示を空にする。storage が読めず実際の状態が分からないときに使う。
 * 何も書かないことで、嘘の状態を表示するより無害な側に倒す。
 */
function clearMode(): void {
  const title = find(SELECTORS.modeTitle);
  if (title) title.textContent = '';
  const detail = find(SELECTORS.modeDetail);
  if (detail) detail.textContent = '';
  const saved = find(SELECTORS.saved);
  if (saved) saved.hidden = true;
}

/** 状態を画面に反映する。生のトークンは扱わない */
function render(state: TokenState): void {
  const copy = describeMode(state);

  const title = find(SELECTORS.modeTitle);
  if (title) title.textContent = copy.title;

  const detail = find(SELECTORS.modeDetail);
  if (detail) detail.textContent = copy.detail;

  // kind は storage の実態と一致する。失敗しても保存済みなら full のままなので、
  // マスク表示と削除ボタンが消えない
  const saved = find(SELECTORS.saved);
  if (saved) saved.hidden = state.kind !== 'full';

  const masked = find(SELECTORS.masked);
  if (masked && state.kind === 'full') masked.textContent = state.masked;

  showMessage(state.kind === 'verifying' ? '' : (state.message ?? ''));
}

/**
 * 入力欄を空にする。**保存に成功したときだけ呼ぶこと。**
 *
 * 以前は render() の中で state の形から「保存成功」を推測していたが、
 * loadState() が返す {kind:'full', masked} は成功時の戻り値と同じ形のため、
 * 失敗後の復帰（restoreMode）でも成功と誤認して入力が消えていた。
 * 推測をやめ、呼び出し側が明示する。
 */
function clearInput(): void {
  const input = find<HTMLInputElement>(SELECTORS.token);
  if (input) input.value = '';
}

/**
 * 過渡状態（確認中）のまま固まらないよう、実際の保存状態へ戻す。
 * storage 自体が読めなければモード表示を空にする。
 */
async function restoreMode(message: string): Promise<void> {
  try {
    render(await loadState());
  } catch (error) {
    logger.error('failed to reload token state:', error);
    clearMode();
  }
  showMessage(message);
}

async function handleSubmit(): Promise<void> {
  // 検証の往復中に届いた操作は無視する（古い応答が新しい入力を消さないように）
  if (busy) return;

  const input = find<HTMLInputElement>(SELECTORS.token);
  if (!input) {
    logger.warn('token input not found');
    return;
  }

  setBusy(true);
  try {
    render({ kind: 'verifying' });
    const next = await submitToken(input.value);
    render(next);
    // 保存できたときだけ入力欄を空にする。失敗時は直せるよう残す。
    // submitToken は失敗時に必ず message を載せるので、ここで成功を判別できる
    if (next.kind === 'full' && next.message === undefined) clearInput();
  } catch (error) {
    // ここで握りつぶすと「確認中」の表示のまま固まる
    logger.error('token submit failed:', error);
    await restoreMode(UNEXPECTED_SUBMIT_ERROR);
  } finally {
    setBusy(false);
  }
}

async function handleRemove(): Promise<void> {
  // 保存の往復中に削除が走ると、後に解決した側が相手の描画を上書きする
  if (busy) return;

  setBusy(true);
  try {
    render(await removeToken());
  } catch (error) {
    logger.error('token removal failed:', error);
    await restoreMode(UNEXPECTED_REMOVE_ERROR);
  } finally {
    setBusy(false);
  }
}

/**
 * イベントリスナーを登録する。
 *
 * **storage の読み込みより先に呼ぶこと。**
 * loadState() が失敗して addEventListener に到達しないと、submit が
 * ブラウザのネイティブ GET 送信になる。options_page はフルタブで開くため、
 * 入力欄の値がアドレスバーと履歴に載る。
 * （入力欄から name 属性を外してあるのは、その場合でも値を送信させないための保険）
 */
function attachListeners(): void {
  const form = find<HTMLFormElement>(SELECTORS.form);
  form?.addEventListener('submit', (event) => {
    // 忘れるとページがリロードして状態が飛ぶ
    event.preventDefault();
    handleSubmit().catch((error: unknown) => {
      logger.error('unexpected submit failure:', error);
      showMessage(UNEXPECTED_SUBMIT_ERROR);
    });
  });

  const remove = find<HTMLButtonElement>(SELECTORS.remove);
  remove?.addEventListener('click', () => {
    handleRemove().catch((error: unknown) => {
      logger.error('unexpected removal failure:', error);
      showMessage(UNEXPECTED_REMOVE_ERROR);
    });
  });
}

/**
 * 候補の見え方（Phase 9 でポップアップから移した 2 つ）を反映する。
 *
 * **トークンの状態とは別に読む。**片方が失敗しても、もう片方は表示できる。
 * どちらも `storage.local` で、判定の閾値（sync）とは置き場が違う。
 */
async function renderPrefs(): Promise<void> {
  const [muteOnValid, foldTarget, aiHintPrefs, aiVerdicts] = await Promise.all([
    getMuteOnValid(),
    getFoldTarget(),
    getAiHintPrefs(),
    getAiVerdicts(),
  ]);

  const toggle = find<HTMLInputElement>(SELECTORS.muteOnValid);
  if (toggle) toggle.checked = muteOnValid;
  renderToggleState(muteOnValid);

  for (const radio of document.querySelectorAll<HTMLInputElement>(SELECTORS.foldTarget)) {
    radio.checked = radio.value === foldTarget;
  }

  renderAiHintPrefs(aiHintPrefs);
  currentAiVerdicts = aiVerdicts;
  renderAgreement(aiHintPrefs.threshold);
}

/** 「そうかも / 違うかも」の回答。線引きを動かしたときに読み直さずに数え直すため持つ */
let currentAiVerdicts: AiVerdictLog = {};

/**
 * 一致率を映す（M3）。いまの線引きの 1 文、1〜8 点の表、旧形式の注記。
 *
 * threshold は**画面に出ている線引き**。スライダーを動かしている途中でも追従させる
 * （保存を待つと、動かした結果がすぐに見えない）。
 */
function renderAgreement(threshold: number): void {
  const summary = find(SELECTORS.aiAgreementSummary);
  if (summary)
    summary.textContent = describeAgreementSummary(agreementAt(currentAiVerdicts, threshold));

  const body = find(SELECTORS.aiAgreementRows);
  if (body) {
    body.replaceChildren(
      ...agreementByThreshold(currentAiVerdicts).map((row) => {
        const tr = document.createElement('tr');
        // いまの線引きの行は aria-current で示す（色だけで伝えない）
        if (row.threshold === threshold) tr.setAttribute('aria-current', 'true');
        const head = document.createElement('th');
        head.scope = 'row';
        head.textContent = `${String(row.threshold)} 点以上`;
        const cell = document.createElement('td');
        cell.textContent = describeAgreementCell(row);
        tr.append(head, cell);
        return tr;
      }),
    );
  }

  const legacy = find(SELECTORS.aiAgreementLegacy);
  if (legacy) {
    const text = describeLegacy(countLegacyAnswers(currentAiVerdicts));
    legacy.hidden = text === null;
    legacy.textContent = text ?? '';
  }
}

/**
 * トレンドで答えたら描き直す。設定画面を開いたまま答えても数字が古くならないように。
 * 読めなくても debug 止まり（表示が古いだけで、拡張が壊れているわけではない）
 */
function watchAiVerdicts(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('aiVerdicts' in changes)) return;
    getAiVerdicts()
      .then((log) => {
        currentAiVerdicts = log;
        renderAgreement(currentAiHintPrefs.threshold);
      })
      .catch((error: unknown) => {
        logger.debug('failed to reload ai verdicts:', error);
      });
  });
}

/**
 * 「AI文体かも？」の線引きの、画面に出ている値。
 *
 * 片方だけ変えたときにもう片方を巻き戻さないよう、保存は常にこの全体で行う。
 * 読み込みに失敗したときは既定値のまま（init で戻す）。
 */
let currentAiHintPrefs: AiHintPrefs = { ...DEFAULT_AI_HINT_PREFS };

/** 「5 / 8 点」。上限を添えて、何点満点かを読めるようにする */
function describeAiThreshold(threshold: number): string {
  return `${String(threshold)} / ${String(AI_HINT_THRESHOLD_RANGE.max)} 点`;
}

function renderAiHintPrefs(prefs: AiHintPrefs): void {
  currentAiHintPrefs = prefs;
  const threshold = find<HTMLInputElement>(SELECTORS.aiThreshold);
  if (threshold) threshold.value = String(prefs.threshold);
  renderAiThresholdValue(prefs.threshold);
  renderMinProse(prefs.minProseChars);
}

/**
 * 最小文字数を映す。**固定値ならそのボタンを押した状態にし、自由入力は空にする。**
 * 空にすると薄い「自由入力」が見え、打てる欄だと分かる。固定値以外なら自由入力に数を出す
 */
function renderMinProse(minProseChars: number): void {
  let matched = false;
  for (const button of presetButtons()) {
    const pressed = Number(button.dataset.minProse) === minProseChars;
    button.setAttribute('aria-pressed', String(pressed));
    matched ||= pressed;
  }
  const minProse = find<HTMLInputElement>(SELECTORS.aiMinProse);
  if (minProse) minProse.value = matched ? '' : String(minProseChars);
}

/**
 * 固定値のボタンの値を読む。**空・空白だけは null。**
 * Number('') は 0 なので、先に弾かないと「0 字（注釈なし）」として保存してしまう
 */
function readPreset(button: HTMLButtonElement): number | null {
  const text = button.dataset.minProse?.trim() ?? '';
  if (text === '') return null;
  const value = Number(text);
  return isIntInRange(value, AI_HINT_MIN_PROSE_RANGE) ? value : null;
}

function presetButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(SELECTORS.aiMinProsePresets)];
}

/**
 * 自由入力の値を読む。**上限を超えたら上限にする**（2001 と打った人は「長め」を望んでいる）。
 * 下限未満・小数・空は null（意図が読めないので保存しない）。
 * Number('') は 0 なので、空欄を「0 字」と読まないよう先に弾く
 */
function readMinProse(input: HTMLInputElement): number | null {
  const text = input.value.trim();
  if (text === '') return null;
  const value = Number(text);
  const clamped =
    Number.isFinite(value) && value > AI_HINT_MIN_PROSE_RANGE.max
      ? AI_HINT_MIN_PROSE_RANGE.max
      : value;
  return isIntInRange(clamped, AI_HINT_MIN_PROSE_RANGE) ? clamped : null;
}

function renderAiThresholdValue(threshold: number): void {
  const output = find(SELECTORS.aiThresholdValue);
  if (output) output.textContent = describeAiThreshold(threshold);
}

/**
 * スライダーの値を整数として読む。**範囲外・小数・空は null。**
 * Number('') は 0 なので、空欄を「0 字」と読まないよう先に弾く
 */
function readInt(input: HTMLInputElement, range: { min: number; max: number }): number | null {
  const text = input.value.trim();
  if (text === '') return null;
  const value = Number(text);
  return isIntInRange(value, range) ? value : null;
}

function saveAiHint(patch: Partial<AiHintPrefs>): void {
  currentAiHintPrefs = { ...currentAiHintPrefs, ...patch };
  saveAiHintPrefs(currentAiHintPrefs).catch((error: unknown) => {
    logger.debug('failed to save ai hint setting:', error);
  });
}

/**
 * 線引きを配線する。**確定したとき（change）だけ保存する。**
 *
 * スライダーはドラッグ中（input）に数字だけ追い、離したときに保存する。
 * 最小文字数は固定値のボタン（押したら保存）と自由入力の 2 通り。自由入力は
 * 打ちかけの「3」で保存しないよう change で検証してから保存し、不正なら保存せず
 * 元の表示に戻す。トレンドのページは storage.onChanged で描き直す。
 */
function attachAiHintListeners(): void {
  const threshold = find<HTMLInputElement>(SELECTORS.aiThreshold);
  if (threshold) {
    // 上限はシグナル数から決める（HTML の値はスクリプトが動く前の表示用）
    threshold.min = String(AI_HINT_THRESHOLD_RANGE.min);
    threshold.max = String(AI_HINT_THRESHOLD_RANGE.max);
    threshold.addEventListener('input', () => {
      const value = readInt(threshold, AI_HINT_THRESHOLD_RANGE);
      if (value === null) return;
      renderAiThresholdValue(value);
      renderAgreement(value);
    });
    threshold.addEventListener('change', () => {
      const value = readInt(threshold, AI_HINT_THRESHOLD_RANGE);
      if (value === null) return;
      renderAiThresholdValue(value);
      renderAgreement(value);
      saveAiHint({ threshold: value });
    });
  }

  for (const button of presetButtons()) {
    button.addEventListener('click', () => {
      const value = readPreset(button);
      // 知らない値は捨てる。HTML を書き換えられても storage に入らない
      if (value === null) return;
      renderMinProse(value);
      saveAiHint({ minProseChars: value });
    });
  }

  const minProse = find<HTMLInputElement>(SELECTORS.aiMinProse);
  minProse?.addEventListener('change', () => {
    const value = readMinProse(minProse);
    if (value === null) {
      renderMinProse(currentAiHintPrefs.minProseChars);
      return;
    }
    renderMinProse(value);
    saveAiHint({ minProseChars: value });
  });
}

/** 「する」「しない」を映す。**init と change の両方から呼ぶ** */
function renderToggleState(checked: boolean): void {
  const state = find(SELECTORS.muteOnValidState);
  if (state) state.textContent = describeToggleState(checked);
}

/**
 * 見え方の設定を配線する。**保存に失敗しても debug 止まり** —
 * ユーザーの操作どおりに動かないのは困るが、拡張が壊れているわけではない。
 */
function attachPrefListeners(): void {
  find<HTMLInputElement>(SELECTORS.muteOnValid)?.addEventListener('change', (event) => {
    const checked = event.target instanceof HTMLInputElement && event.target.checked;
    // 保存を待たずに映す。storage の往復を待つと、押した瞬間の文言が古いまま残る
    renderToggleState(checked);
    saveMuteOnValid(checked).catch((error: unknown) => {
      logger.debug('failed to save mute setting:', error);
    });
  });

  for (const radio of document.querySelectorAll<HTMLInputElement>(SELECTORS.foldTarget)) {
    radio.addEventListener('change', (event) => {
      const value: unknown = event.target instanceof HTMLInputElement ? event.target.value : null;
      // 知らない値は捨てる。HTML を書き換えられても storage に入らない
      if (!isFoldTarget(value)) return;
      saveFoldTarget(value).catch((error: unknown) => {
        logger.debug('failed to save fold setting:', error);
      });
    });
  }
}

/**
 * ページを初期化する。
 * 保存状態の読み込みに失敗しても、リスナーだけは必ず付いた状態にする。
 */
export async function init(): Promise<void> {
  setBusy(false);
  currentAiHintPrefs = { ...DEFAULT_AI_HINT_PREFS };
  currentAiVerdicts = {};
  attachListeners();
  attachPrefListeners();
  attachAiHintListeners();
  watchAiVerdicts();
  try {
    render(await loadState());
  } catch (error) {
    logger.error('failed to load token state:', error);
    clearMode();
    showMessage('設定の読み込みに失敗しました。ページを再読み込みしてください。');
  }
  // トークンの読み込みが失敗しても見え方の設定は出す（別の storage キー）
  try {
    await renderPrefs();
  } catch (error) {
    logger.error('failed to load display preferences:', error);
  }
}
