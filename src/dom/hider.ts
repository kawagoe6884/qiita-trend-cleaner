/**
 * 評価済みの候補の記事を、表示中のページから隠す。
 *
 * **DOM を書き換えるのは拡張でここだけ。**他の dom/ モジュールは読み取り専用。
 *
 * 【隠すのは「妥当」と評価されたものだけ】
 * candidates ではなく feedback を見る。閾値を動かすと候補は再計算で作り直されるが、
 * 評価は人間が積み上げた資産で戻らない。「妥当」と判断した著者を隠し続けるのは
 * ユーザーの意思であり、その後スライダーを動かして候補から外れても関係ない。
 *
 * 【hidden 属性ではなくインラインの display を使う理由】
 * Qiita 側の CSS がカードに display を指定していると、UA スタイルの
 * `[hidden]{display:none}` が負けて要素が消えない（Phase 6 で踏んだ）。
 * インラインスタイルは class より優先度が高いので確実に消える。
 *
 * 【remove() しない理由】
 * 戻せなくなる。誤検知でミュートすると視界から消えて再評価できない（OQ-16）のと
 * 同じ形を、非表示でも作らない。
 *
 * 【取れなければ何もしない】
 * カードが特定できなければ黙って諦める（設計上の約束 3）。
 * 誤った対象を隠すより、何もしない方が無害。
 */
import { SELECTORS, HIDDEN_MARKER, HIGHLIGHT_MARKER, NOTICE_ID } from './selectors';
import { readTrendItems, findCard } from './trend-reader';
import type { AccountHandle, FeedbackLog } from '../types/domain';

/** dataset のキー（qtgHidden）に対応する属性セレクタ */
const HIDDEN_ATTR_SELECTOR = '[data-qtg-hidden="true"]';

/** dataset のキー（qtgJudged）に対応する属性セレクタ */
const HIGHLIGHT_ATTR_SELECTOR = '[data-qtg-judged="true"]';

/**
 * 「妥当」と判断されたカードの背景。
 *
 * **半透明にするのは Qiita のライト / ダークの両方で機能させるため。**
 * 赤は使わない — 「不正」と断定しないという設計上の約束 6 は、文言だけでなく
 * 見た目にも及ぶ。控えめな琥珀に留める。
 */
const HIGHLIGHT_BACKGROUND = 'rgba(255, 170, 0, 0.12)';

/** 隠した結果。呼び出し側がログと通知に使う */
export interface HideResult {
  hidden: number;
  /** 隠した著者（重複なし・昇順）。ログ用 */
  authors: AccountHandle[];
}

/** 既に拡張が隠しているか */
function isHidden(element: HTMLElement): boolean {
  return element.dataset[HIDDEN_MARKER] === 'true';
}

/**
 * feedback が valid の著者の記事カードを隠す。
 *
 * 記事の走査は readTrendItems に任せる。URL の形式検証（".." を弾く等）を
 * 二重に書かないため。
 */
export function hideJudgedAuthors(feedback: FeedbackLog, root: ParentNode = document): HideResult {
  const targets = new Set(
    readTrendItems(root)
      .filter((item) => feedback[item.authorHandle] === 'valid')
      .map((item) => item.authorHandle),
  );
  if (targets.size === 0) return { hidden: 0, authors: [] };

  const hiddenAuthors = new Set<AccountHandle>();
  let hidden = 0;

  for (const link of root.querySelectorAll<HTMLAnchorElement>(SELECTORS.trendItemLink)) {
    const card = findCard(link);
    if (!(card instanceof HTMLElement)) continue;
    // 1 カードに記事リンクが 2 本あるので、同じカードに 2 回来る
    if (isHidden(card)) continue;

    // どの著者のカードかは、そのカード内の記事リンクから引く
    const [item] = readTrendItems(card);
    if (item === undefined || !targets.has(item.authorHandle)) continue;

    card.style.display = 'none';
    card.dataset[HIDDEN_MARKER] = 'true';
    // 背景の目印は「表示する」で戻したときに残る。どのカードが該当かが
    // 分からないと、誤検知の確認ができない
    card.style.backgroundColor = HIGHLIGHT_BACKGROUND;
    card.dataset[HIGHLIGHT_MARKER] = 'true';
    hiddenAuthors.add(item.authorHandle);
    hidden += 1;
  }

  return { hidden, authors: [...hiddenAuthors].sort() };
}

/** 拡張が隠した要素だけを列挙する。Qiita 自身が隠しているものは含まない */
function hiddenCards(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(HIDDEN_ATTR_SELECTOR)];
}

/** いま拡張が隠している件数 */
export function countHidden(root: ParentNode = document): number {
  return hiddenCards(root).length;
}

/**
 * 拡張が隠したものを全部戻す。戻した件数を返す。
 *
 * **そのページだけ**の効果で、リロードすると再び隠れる。恒久的に戻したければ
 * ポップアップで「誤り」に押し直す。評価が唯一の入力という設計を崩さない。
 */
export function unhideAll(root: ParentNode = document): number {
  const cards = hiddenCards(root);
  for (const card of cards) {
    card.style.removeProperty('display');
    delete card.dataset[HIDDEN_MARKER];
  }
  return cards.length;
}

/**
 * 背景の目印を消す。**評価が変わったときに呼ぶ。**
 *
 * unhideAll は display だけを戻し、背景は残す（「表示する」で戻したときに
 * どのカードが該当かを示すため）。評価そのものが変わったときは、
 * ここで消してから付け直す。
 */
export function clearHighlights(root: ParentNode = document): number {
  const cards = [...root.querySelectorAll<HTMLElement>(HIGHLIGHT_ATTR_SELECTOR)];
  for (const card of cards) {
    card.style.removeProperty('background-color');
    delete card.dataset[HIGHLIGHT_MARKER];
  }
  return cards.length;
}

/** 通知の状態。隠れているか、手で表示中か */
export type NoticeMode = 'hidden' | 'shown';

/** 通知に載せる文言。**断定しない**（設計上の約束 6） */
export function describeHidden(count: number, mode: NoticeMode = 'hidden'): string {
  return mode === 'hidden' ? `${String(count)} 件を非表示中` : `${String(count)} 件を表示中`;
}

/**
 * ボタンの文言。**押した後どうなるか**を書く。
 *
 * 「隠す」を全角スペースで挟んで「表示する」と同じ 4 文字幅にする。
 * **押すたびにボタンの幅が変わると、通知そのものが動いて目で追えない。**
 */
export function noticeAction(mode: NoticeMode): string {
  return mode === 'hidden' ? '表示する' : '　隠す　';
}

/**
 * 「N 件を非表示中 / 表示する」と「N 件を表示中 / 隠す」を切り替える。
 * **0 件なら要素ごと消す。**
 *
 * 【トグルである理由】
 * 「表示する」だけを置いていたとき、押したあとに戻す手段が無かった。
 * ユーザーは「妥当」を押し直そうとしたが、**評価が既に valid なので
 * storage の値が変わらず、onChanged が発火しない**（Chrome は値が実際に
 * 変わったときだけ発火する）。何も起きないように見える。
 * 「隠す」を押せる状態を用意して、操作の対称性を取る。
 *
 * 既にあれば文言だけ書き換える。毎回作り直すと、ボタンを押す瞬間に
 * 要素が差し替わってクリックが落ちる。
 *
 * position: fixed で右下に置くのは、Qiita のレイアウト構造に依存しないため。
 * innerHTML は使わない（方針を揃える）。
 */
export function renderNotice(
  count: number,
  onToggle: () => void,
  root: ParentNode = document,
  mode: NoticeMode = 'hidden',
): void {
  const existing = root.querySelector<HTMLElement>(`#${NOTICE_ID}`);

  if (count === 0) {
    existing?.remove();
    return;
  }

  if (existing) {
    const label = existing.querySelector('span');
    if (label) label.textContent = describeHidden(count, mode);
    const action = existing.querySelector('button');
    if (action) action.textContent = noticeAction(mode);
    return;
  }

  const container = document.createElement('div');
  container.id = NOTICE_ID;
  container.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:9999',
    'display:flex',
    'gap:8px',
    'align-items:center',
    'padding:8px 12px',
    'border-radius:8px',
    'background:rgba(0,0,0,0.78)',
    'color:#fff',
    'font-size:13px',
    'font-family:system-ui,sans-serif',
  ].join(';');

  const label = document.createElement('span');
  label.textContent = describeHidden(count, mode);

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = noticeAction(mode);
  button.style.cssText = [
    'cursor:pointer',
    'border:1px solid rgba(255,255,255,0.5)',
    'border-radius:4px',
    'background:transparent',
    'color:inherit',
    'font:inherit',
    'padding:2px 8px',
  ].join(';');
  button.addEventListener('click', onToggle);

  container.append(label, button);
  document.body.append(container);
}
