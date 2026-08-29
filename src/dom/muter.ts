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
 * メニューが描画されるのを待つ上限。
 *
 * **React は状態更新を同期で描画しない。**2026-08-24 の実機で、ボタンを押した
 * 直後の `[role="menu"]` は **0 件**、300ms 後に 1 件だった。押した直後に読む
 * 実装では永久に見つからない。
 *
 * Snackbar より短くしてあるのは、メニューが出ないのは通信の遅延ではなく
 * **画面構造の変化**であり、待っても状況が変わらないため。
 */
export const MENU_TIMEOUT_MS = 2000;

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
 * 条件が満たされるまで DOM の変化を待つ。満たされれば値、時間切れなら null。
 *
 * **固定 sleep を使わない。**メニューの描画も Snackbar の完了通知も、
 * 出るまで待って次へ進む。
 *
 * 観測対象は常に document.documentElement — Snackbar はカードの外
 * （body 直下）にマウントされる。読む側は root を尊重する（テストのため）。
 */
function waitForDom<T>(read: () => T | null, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    // 同期で現れることもありうる。先に見る
    const immediate = read();
    if (immediate !== null) {
      resolve(immediate);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let observer: MutationObserver | null = null;

    const finish = (value: T | null): void => {
      observer?.disconnect();
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };

    observer = new MutationObserver(() => {
      const value = read();
      if (value !== null) finish(value);
    });
    timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

/**
 * aria-controls が指すメニューを探す。
 *
 * **`#id` のセレクタを組み立てない。**React の生成 ID は `:Relbk39a:` のように
 * コロンを含み、CSS セレクタとしては不正で SyntaxError になる（2026-08-24 実測）。
 * [role="menu"] を列挙して id を比較すれば、文字列のエスケープが要らず壊れようが無い。
 */
function findMenuById(menuId: string, root: ParentNode): HTMLElement | null {
  for (const menu of root.querySelectorAll<HTMLElement>(SELECTORS.cardMenu)) {
    if (menu.id === menuId) return menu;
  }
  return null;
}

/**
 * 三点メニューを開き、**描画されるのを待って**メニュー要素を返す。
 *
 * 【押した直後に読んではいけない】
 * React は状態更新を同期で描画しない。2026-08-24 の実機では、click 直後の
 * `[role="menu"]` が **0 件**、300ms 後に 1 件だった。**同期で読む実装は
 * 実機で必ず失敗する。**テストのフィクスチャがメニューを最初から DOM に
 * 置いていたため、この穴は実機に出るまで一度も検査されていなかった。
 *
 * aria-controls はクリックの前後どちらでも取れる（実測）が、**あとで読む**。
 * 開いたときに初めて設定する実装に変わっても動くため。
 *
 * aria-controls が無ければ null。**カード内の [role="menu"] を代わりに探すような
 * 当て推量はしない** — 実測されているのは aria-controls 経由の 1 本だけ。
 */
async function openMenu(
  card: HTMLElement,
  root: ParentNode,
  timeoutMs: number,
): Promise<HTMLElement | null> {
  const button = card.querySelector<HTMLElement>(SELECTORS.cardMenuButton);
  if (button === null) return null;

  button.click();

  const menuId = button.getAttribute('aria-controls');
  if (menuId === null || menuId === '') return null;
  return waitForDom(() => findMenuById(menuId, root), timeoutMs);
}

/**
 * ラベルが「投稿ユーザーをミュート」**で終わる**か。
 *
 * 【なぜ完全一致ではないのか】
 * 実測の textContent は **`volume_off投稿ユーザーをミュート`** だった
 * （2026-08-24）。Material Symbols のアイコンはリガチャ、つまり**テキスト**として
 * 項目の先頭に入るため、完全一致は成立しない。
 *
 * 【なぜ includes ではないのか】
 * **接尾辞が付いたら意味が変わる。**「〜を解除」が付けば逆の操作になり、
 * includes だと解除を押してしまう。アイコンは必ず前に付くので、
 * **前は許して後ろは許さない**という規則がちょうど手口に合う。
 *
 * これが誤爆を止める砦。ブロックは「投稿ユーザーをブロック」なので当然一致しない。
 */
function isMuteLabel(text: string | null): boolean {
  return (text ?? '').trim().endsWith(MENU_TEXT.mute);
}

/**
 * ミュートの項目だけを返す。一致しなければ null。
 *
 * 既にミュート済みなら文言が解除側に変わって一致せず、**何も押さない。**
 * **押す対象を決めるのはこの関数だけ**で、ここは `MENU_TEXT.mute` しか見ない。
 */
export function findMuteItem(menu: ParentNode): HTMLElement | null {
  for (const item of menu.querySelectorAll<HTMLElement>(SELECTORS.menuItem)) {
    if (isMuteLabel(item.textContent)) return item;
  }
  return null;
}

/**
 * 解除側の項目があるか。**あれば「いまミュート中」という事実。**
 *
 * ⚠️ **要素ではなく boolean を返す。**要素を返すと呼び出し側が押せてしまう。
 * 押せない形で返すことが、「解除の文言は読むためだけに持つ」という約束を
 * コードで担保する唯一の方法（`MENU_TEXT.unmute` の JSDoc）。
 *
 * 押す経路は `findMuteItem` 1 本のままで、そこは `endsWith(MENU_TEXT.mute)`
 * なので解除側には決して一致しない。
 */
export function isAlreadyMuted(menu: ParentNode): boolean {
  for (const item of menu.querySelectorAll<HTMLElement>(SELECTORS.menuItem)) {
    if ((item.textContent ?? '').trim().endsWith(MENU_TEXT.unmute)) return true;
  }
  return false;
}

/**
 * 項目の中で実際に押す要素を返す。
 *
 * **`[role="menuitem"]` は器で、ハンドラは中の `<button>` にある**（2026-08-24 実測）。
 * イベントは下へ伝播しないため、器を押しても何も起きない。**実機ではこれで
 * 「押したのに何も起きない」（timeout）になっていた。**
 *
 * 中に button が無ければ器そのものを返す。器自体が押せる形に変わっても動き、
 * どちらでもなければ何も起きない（フェイルセーフ）。
 *
 * **探索は器の中に閉じている**ので、隣の項目（ブロック）を踏むことは起きない。
 */
export function actionOf(item: HTMLElement): HTMLElement {
  return item.querySelector<HTMLElement>(SELECTORS.menuItemAction) ?? item;
}

/** Snackbar に指定のメッセージが出るまで待つ。出れば true、時間切れなら false */
export async function waitForSnackbar(
  expected: string,
  root: ParentNode = document,
  timeoutMs: number = SNACKBAR_TIMEOUT_MS,
): Promise<boolean> {
  const found = await waitForDom(
    () => (readSnackbarMessage(root) === expected ? true : null),
    timeoutMs,
  );
  return found === true;
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
    // メニューは Snackbar より短く打ち切る。出ないのは通信ではなく構造の変化で、
    // 待っても状況が変わらない。テストが短い上限を渡したときはそちらに従う
    const menu = await openMenu(card, root, Math.min(timeoutMs, MENU_TIMEOUT_MS));
    if (menu === null) return 'menu-unavailable';

    const item = findMuteItem(menu);
    if (item === null) {
      // 一致しなければ何も押さない。**押さないまま、なぜ無いのかだけ見分ける** —
      // 解除側があるなら「いまミュート中」という事実で、画面構造の変化ではない。
      // ここを分けないと、UI が「既にミュート済みか、構造が変わったか」と
      // 推測を並べるしかなくなる（2026-08-29 の方針転換）
      return isAlreadyMuted(menu) ? 'already-muted' : 'menu-unavailable';
    }

    // **器ではなく中身を押す。**li を押しても何も起きない（actionOf の理由）
    actionOf(item).click();
    const done = await waitForSnackbar(SNACKBAR_TEXT.muteCompleted, root, timeoutMs);
    return done ? 'muted' : 'timeout';
  } finally {
    if (restored) concealCard(card);
  }
}
