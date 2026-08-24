/**
 * トレンドカードから Qiita 公式のミュートを実行する。
 *
 * **DOM を書き換えるモジュールは hider.ts とこれの 2 つだけ。**
 *
 * 【ブロックを絶対に押さない】
 * メニューは「フォロー / **ブロック** / ミュート」の順で、**ブロックがミュートの
 * 直上にある**（2026-08-24 実測）。ブロックは native alert() を起動して
 * content script から閉じられず、解除用の一覧 URL も存在しないので誤検知を
 * 回収できない（設計上の約束 7）。
 * **順序・インデックス・部分一致では選ばない。テキスト完全一致だけ。**
 *
 * 【既にミュート済みなら何もしない】
 * 項目はトグルなので、ミュート済みだと文言が解除側に変わる。完全一致なら
 * 一致せず何も押さない。**解除の文言は実装に持ち込まない** — 持ち込むと
 * それを押す経路ができる。知らない方が安全。
 *
 * 【隠れているカードでも動く】
 * Phase 7 が「妥当」でカードを display:none にする。ミュートと非表示は同じ
 * 操作から同時に走り、**順序が保証されない**。ここで一時的に表示へ戻し、
 * finally で必ず隠し直す。どちらが先でも同じ結果になる。
 * jsdom は CSS のカスケードを評価しないので、「隠れていても click は飛ぶ」に
 * 賭けると実機でしか出ない不具合になる。
 *
 * 【失敗しても投げない】
 * 何が起きたかを MuteOutcome で返す。呼び出し側が UI に出す（設計上の約束 3）。
 */
import { SELECTORS, MENU_TEXT, SNACKBAR_TEXT, readSnackbarMessage } from './selectors';
import { readTrendCards } from './trend-reader';
import { revealCard, concealCard } from './hider';
import type { AccountHandle, MuteOutcome } from '../types/domain';

/**
 * 連続実行の間隔（ミリ秒）。**手動操作と同程度の負荷に留める。**
 * 呼び出し側（content script）が直列化と合わせて使う。
 */
export const MUTE_INTERVAL_MS = 1000;

/** Snackbar を待つ上限。出なければ timeout として返す */
export const SNACKBAR_TIMEOUT_MS = 5000;

/**
 * 著者のカードを 1 枚返す。**隠れているカードも対象。**
 *
 * 同じ著者の記事が 2 本トレンドに出ていても、ミュートは 1 回で足りるので
 * 最初の 1 枚だけを返す。
 */
export function findAuthorCard(
  handle: AccountHandle,
  root: ParentNode = document,
): HTMLElement | null {
  return readTrendCards(root).find((entry) => entry.item.authorHandle === handle)?.card ?? null;
}

/**
 * 三点メニューを開き、開いたメニュー要素を返す。
 *
 * **aria-controls はクリックしたあとに読む。**React は開いたときに初めて
 * 属性を設定することがある。
 *
 * **`#id` のセレクタを組み立てない。**React の生成 ID は `:r1:` のように
 * コロンを含み、CSS セレクタとしては不正で SyntaxError になる。
 * [role="menu"] を列挙して id を比較すれば、文字列のエスケープが要らず壊れようが無い。
 *
 * aria-controls が無ければ null。**カード内の [role="menu"] を代わりに探すような
 * 当て推量はしない** — 実測されているのは aria-controls 経由の 1 本だけ。
 */
function openMenu(card: HTMLElement, root: ParentNode): HTMLElement | null {
  const button = card.querySelector<HTMLElement>(SELECTORS.cardMenuButton);
  if (button === null) return null;

  button.click();

  const menuId = button.getAttribute('aria-controls');
  if (menuId === null || menuId === '') return null;
  for (const menu of root.querySelectorAll<HTMLElement>(SELECTORS.cardMenu)) {
    if (menu.id === menuId) return menu;
  }
  return null;
}

/**
 * 「投稿ユーザーをミュート」に **完全一致** する項目だけを返す。
 * 一致しなければ null。**ここが誤爆を止める唯一の砦。**
 *
 * includes や startsWith にしないこと。ミュート済みのときに出る解除側の文言も
 * 「ミュート」を含むため、部分一致にすると解除を押してしまう。
 */
export function findMuteItem(menu: ParentNode): HTMLElement | null {
  for (const item of menu.querySelectorAll<HTMLElement>(SELECTORS.menuItem)) {
    if (item.textContent?.trim() === MENU_TEXT.mute) return item;
  }
  return null;
}

/**
 * Snackbar に指定のメッセージが出るまで待つ。出れば true、時間切れなら false。
 *
 * **固定 sleep を使わない。**1 件ごとに成功を確認してから次へ進めるので、
 * 連続実行が堅牢になる。
 *
 * 観測対象は常に document.documentElement — Snackbar はカードの外
 * （body 直下）にマウントされる。読む側は root を尊重する（テストのため）。
 */
export function waitForSnackbar(
  expected: string,
  root: ParentNode = document,
  timeoutMs: number = SNACKBAR_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    // クリックが同期的に Snackbar を出すこともありうる。先に見る
    if (readSnackbarMessage(root) === expected) {
      resolve(true);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let observer: MutationObserver | null = null;

    const finish = (found: boolean): void => {
      observer?.disconnect();
      if (timer !== null) clearTimeout(timer);
      resolve(found);
    };

    observer = new MutationObserver(() => {
      if (readSnackbarMessage(root) === expected) finish(true);
    });
    timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

/**
 * 著者を 1 人ミュートする。**例外を投げない。**
 *
 * 隠れているカードは一時的に戻し、finally で必ず隠し直す。
 * 途中で何が起きても隠れた状態に復帰する。
 */
export async function muteAuthor(
  handle: AccountHandle,
  root: ParentNode = document,
  timeoutMs: number = SNACKBAR_TIMEOUT_MS,
): Promise<MuteOutcome> {
  const card = findAuthorCard(handle, root);
  if (card === null) return 'not-on-page';

  const restored = revealCard(card);
  try {
    const menu = openMenu(card, root);
    if (menu === null) return 'menu-unavailable';

    const item = findMuteItem(menu);
    // 一致しなければ何も押さない。既にミュート済みならここに来る
    if (item === null) return 'menu-unavailable';

    item.click();
    const done = await waitForSnackbar(SNACKBAR_TEXT.muteCompleted, root, timeoutMs);
    return done ? 'muted' : 'timeout';
  } finally {
    if (restored) concealCard(card);
  }
}
