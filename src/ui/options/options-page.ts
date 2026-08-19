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
} as const;

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
 * ページを初期化する。
 * 保存状態の読み込みに失敗しても、リスナーだけは必ず付いた状態にする。
 */
export async function init(): Promise<void> {
  setBusy(false);
  attachListeners();
  try {
    render(await loadState());
  } catch (error) {
    logger.error('failed to load token state:', error);
    clearMode();
    showMessage('設定の読み込みに失敗しました。ページを再読み込みしてください。');
  }
}
