/**
 * トレンドのカードの右上に「AI文体かも？」を控えめに重ねる。
 *
 * 【全記事に出す】（Plan D4・ユーザー確定）
 * 閾値以上の記事だけに出すと、利用者の回答が「出したもののうち当たった割合」
 * しか測れない。見逃しも測るため、スコアのある記事すべてに出し、
 * 閾値以上だけを強調する。
 *
 * 【断定しない】（README「断定はしません」）
 * 測っているのは文体だけなので「AI文体かも？」と書く（「AIかも？」は書き手を
 * 指すように読める — 2026-10-24 ユーザー確定）。点数は title にだけ出す。
 * 赤は使わない — hider の背景色と同じく、控えめな琥珀に留める。
 *
 * 【回答を急かさない】（2026-10-24 ユーザー確定）
 * 当たり / 外れのボタンが常に見えていると、押す義務があるように感じる。
 * ラベルに乗せた時（キーボードではフォーカスした時）だけ出し、回答済みの記事には
 * ✓ だけを残す。:hover はインラインの style で書けないので、規則を 1 つ head に入れる。
 *
 * 【Qiita の DOM に依存しない】
 * カードの特定は trend-reader に任せ、ここはカードの右上に 1 要素重ねるだけ。
 * innerHTML は使わない（hider と方針を揃える）。
 */
import { AI_HINT_MARKER, AI_HINT_STYLE_ID } from './selectors';
import { readTrendCards } from './trend-reader';
import { isAiLikely, isShortProse } from '../detect/ai-style';
import { AI_SIGNALS, DEFAULT_AI_HINT_PREFS } from '../types/domain';
import type {
  AiHint,
  AiHintLog,
  AiHintPrefs,
  AiVerdict,
  AiVerdictLog,
  ItemId,
} from '../types/domain';

/** dataset のキー（qtgAiHint）に対応する属性セレクタ */
const AI_HINT_ATTR_SELECTOR = '[data-qtg-ai-hint]';

/** 右上に置くためにカードへ position を付けた印（dataset のキー名） */
const AI_ANCHOR_MARKER = 'qtgAiAnchor';
const AI_ANCHOR_ATTR_SELECTOR = '[data-qtg-ai-anchor="true"]';

/** ラベルの文言 */
const LABEL = 'AI文体かも？';

/** 回答ボタンの文言。保存する値は yes / no のまま（一致率の入力を変えない） */
const ANSWER_TEXT: Record<AiVerdict, string> = { yes: '当たり', no: '外れ' };

/** 強調するときの背景。Qiita のライト / ダークの両方で読めるよう半透明にする */
const LIKELY_BACKGROUND = 'rgba(255, 170, 0, 0.18)';

/** 地の文が短い記事への注釈（Plan D4・ユーザー確定の文言） */
const SHORT_PROSE_NOTE = '（短文のため判定が甘い可能性あり）';

/** 回答ボタンの入れ物と、回答済みの印のクラス。スタイルの規則から引く */
const ANSWERS_CLASS = 'qtg-ai-answers';
const DONE_CLASS = 'qtg-ai-done';

/** ボタンを普段は隠し、乗せた時・フォーカスした時だけ出す規則 */
const HOVER_RULES = [
  `${AI_HINT_ATTR_SELECTOR} .${ANSWERS_CLASS} { display: none; gap: 4px; }`,
  `${AI_HINT_ATTR_SELECTOR}:hover .${ANSWERS_CLASS},`,
  `${AI_HINT_ATTR_SELECTOR}:focus-within .${ANSWERS_CLASS} { display: inline-flex; }`,
].join('\n');

/** 押したときに呼ばれる。保存は呼び出し側（content script）の責務 */
export type AiAnswerHandler = (itemId: ItemId, verdict: AiVerdict) => void;

/** title に出す説明。点数は「目安」であって判定ではないと書く */
export function describeAiHint(hint: AiHint): string {
  return `文体の目安 ${String(hint.fired.length)} / ${String(AI_SIGNALS.length)}（断定ではありません）`;
}

/** スタイルの規則を 1 つだけ入れる。body ではなく head に置く（描き直しの監視の外） */
function ensureStyle(): void {
  if (document.getElementById(AI_HINT_STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = AI_HINT_STYLE_ID;
  style.textContent = HOVER_RULES;
  document.head.append(style);
}

function answerButton(
  itemId: ItemId,
  verdict: AiVerdict,
  pressed: boolean,
  onAnswer: AiAnswerHandler,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = ANSWER_TEXT[verdict];
  button.setAttribute('aria-pressed', String(pressed));
  button.style.cssText = [
    'cursor:pointer',
    'border:1px solid currentColor',
    'border-radius:4px',
    'background:transparent',
    'color:inherit',
    'font:inherit',
    'padding:0 6px',
    `opacity:${pressed ? '1' : '0.6'}`,
    `font-weight:${pressed ? 'bold' : 'normal'}`,
  ].join(';');
  button.addEventListener('click', (event) => {
    // カードがリンクの中にあっても記事へ飛ばない
    event.preventDefault();
    event.stopPropagation();
    onAnswer(itemId, verdict);
  });
  return button;
}

/** 1 行目: ラベル・回答済みの印・（乗せた時だけ）回答ボタン */
function labelRow(
  itemId: ItemId,
  verdict: AiVerdict | undefined,
  onAnswer: AiAnswerHandler,
): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = ['display:flex', 'gap:6px', 'align-items:center'].join(';');

  const label = document.createElement('span');
  label.textContent = LABEL;
  row.append(label);

  if (verdict !== undefined) {
    const done = document.createElement('span');
    done.className = DONE_CLASS;
    done.textContent = '✓';
    done.title = `回答済み: ${ANSWER_TEXT[verdict]}`;
    row.append(done);
  }

  const answers = document.createElement('span');
  answers.className = ANSWERS_CLASS;
  answers.append(
    answerButton(itemId, 'yes', verdict === 'yes', onAnswer),
    answerButton(itemId, 'no', verdict === 'no', onAnswer),
  );
  row.append(answers);
  return row;
}

/** 1 記事分の中身を組み立てる。既存の要素があれば中身だけ差し替える */
function fillHint(
  container: HTMLElement,
  itemId: ItemId,
  hint: AiHint,
  verdict: AiVerdict | undefined,
  onAnswer: AiAnswerHandler,
  prefs: AiHintPrefs,
): void {
  const likely = isAiLikely(hint, prefs.threshold);
  container.dataset[AI_HINT_MARKER] = itemId;
  container.dataset.qtgAiLikely = String(likely);
  container.title = describeAiHint(hint);
  // キーボードでもボタンを出せるように（:focus-within）
  container.tabIndex = 0;
  container.style.cssText = [
    // カードの右上に重ねる。末尾に足すとカードが 1 行ぶん間延びした（2026-10-24 実機）。
    // 右上は著者行の反対側で、Qiita が何も置いていない
    'position:absolute',
    'top:12px',
    'right:12px',
    'z-index:1',
    // 注釈は 2 行目に置き、右端をラベルの行とそろえる
    'display:flex',
    'flex-direction:column',
    'align-items:flex-end',
    'gap:2px',
    'padding:1px 6px',
    'border-radius:4px',
    'font-size:12px',
    `opacity:${likely ? '1' : '0.55'}`,
    `background:${likely ? LIKELY_BACKGROUND : 'transparent'}`,
  ].join(';');

  const rows: HTMLElement[] = [labelRow(itemId, verdict, onAnswer)];
  if (isShortProse(hint, prefs.minProseChars)) {
    const note = document.createElement('div');
    note.textContent = SHORT_PROSE_NOTE;
    rows.push(note);
  }
  container.replaceChildren(...rows);
}

/**
 * スコアのある記事のカードに表示を足す（または描き直す）。描いた件数を返す。
 *
 * 描き直しでは要素を作り直さず中身だけ替える。カードの中で位置が動くと、
 * 回答のたびに目で追い直すことになる。
 *
 * prefs は利用者の線引き（何点以上を強調し、何字未満に注釈を付けるか）。
 */
export function renderAiHints(
  hints: AiHintLog,
  verdicts: AiVerdictLog,
  onAnswer: AiAnswerHandler,
  prefs: AiHintPrefs = DEFAULT_AI_HINT_PREFS,
  root: ParentNode = document,
): number {
  let rendered = 0;
  for (const { item, card } of readTrendCards(root)) {
    const hint = hints[item.itemId];
    if (hint === undefined) continue;
    ensureStyle();
    const container =
      card.querySelector<HTMLElement>(AI_HINT_ATTR_SELECTOR) ?? document.createElement('div');
    fillHint(container, item.itemId, hint, verdicts[item.itemId], onAnswer, prefs);
    if (!container.isConnected) {
      anchorCard(card);
      card.append(container);
    }
    rendered += 1;
  }
  return rendered;
}

/**
 * 右上に置くための基準をカードに作る。**位置指定の無いカードにだけ** relative を付け、
 * 付けたことを印に残す（clearAiHints が戻すため）。Qiita が既に位置指定していれば触らない。
 */
function anchorCard(card: HTMLElement): void {
  const position = card.style.position || getComputedStyle(card).position;
  if (position !== '' && position !== 'static') return;
  card.style.position = 'relative';
  card.dataset[AI_ANCHOR_MARKER] = 'true';
}

/**
 * DOM の変化が**拡張自身の描画によるもの**か。
 *
 * content script は「表示が消えたら描き直す」ためにページを監視する。自分の描画にも
 * 反応すると、描く → 変化 → 描く… と止まらなくなる。表示の中の変化と、表示そのものの
 * 追加・削除だけを自分のものとみなす。
 */
export function isOwnMutation(record: MutationRecord): boolean {
  // instanceof Element は使わない。ページの破棄後に届いた記録でも、グローバルの
  // Element が引けずに落ちることがない（テストの後片付けで実際に起きた）
  const target = record.target as Partial<Element>;
  if (typeof target.closest === 'function' && target.closest(AI_HINT_ATTR_SELECTOR) !== null) {
    return true;
  }
  const nodes = [...record.addedNodes, ...record.removedNodes];
  return (
    nodes.length > 0 &&
    nodes.every((node) => {
      const dataset = (node as Partial<HTMLElement>).dataset;
      return dataset !== undefined && AI_HINT_MARKER in dataset;
    })
  );
}

/**
 * 拡張が足した表示を全部消す。消した件数を返す。
 *
 * hider が remove() しないのは Qiita の要素を戻せなくなるからで、
 * これは拡張自身が作った要素なので消してよい。右上に置くために
 * カードへ付けた position と、入れたスタイルも戻す。
 */
export function clearAiHints(root: ParentNode = document): number {
  const elements = [...root.querySelectorAll<HTMLElement>(AI_HINT_ATTR_SELECTOR)];
  for (const element of elements) element.remove();
  for (const card of root.querySelectorAll<HTMLElement>(AI_ANCHOR_ATTR_SELECTOR)) {
    card.style.removeProperty('position');
    delete card.dataset[AI_ANCHOR_MARKER];
  }
  document.getElementById(AI_HINT_STYLE_ID)?.remove();
  return elements.length;
}
