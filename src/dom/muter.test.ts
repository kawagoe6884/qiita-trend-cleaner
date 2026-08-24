import { describe, it, expect, beforeEach } from 'vitest';
import { muteAuthor, findAuthorCard, findMuteItem, waitForSnackbar } from './muter';
import { concealCard } from './hider';
import { SELECTORS, MENU_TEXT, SNACKBAR_TEXT } from './selectors';

/** 実測どおりの並び。**ブロックがミュートの直上**にある */
const DEFAULT_ITEMS = ['投稿ユーザーをフォロー', MENU_TEXT.block, MENU_TEXT.mute];

/** 既にミュート済みのときに出る側の文言。**実装は知らないが、テストは知っていてよい** */
const UNMUTE_TEXT = '投稿ユーザーのミュートを解除';

/** 待たされたくないテスト用の短い上限（ミリ秒） */
const FAST_TIMEOUT_MS = 10;

/**
 * メニュー付きのカード 1 枚分。実測どおり **記事リンクを 2 本** 持たせ、
 * メニューは既定で「フォロー / ブロック / ミュート」の順にする。
 *
 * menuId に既定でコロンを入れるのは、React の生成 ID（`:r1:` 形式）を模すため。
 * `#id` のセレクタを組み立てる実装だと SyntaxError で落ちる。
 *
 * フィクスチャは合成値のみ。実アカウント名・実 item_id は使わない。
 */
function cardWithMenu(
  n: number,
  items: string[] = DEFAULT_ITEMS,
  menuId = `:r${String(n)}:`,
  author = `example-author-${String(n)}`,
): string {
  const itemId = `0123456789abcdef${String(n).padStart(4, '0')}`;
  const url = `https://qiita.com/${author}/items/${itemId}`;
  const menuItems = items
    .map((text) => `<li role="menuitem" data-label="${text}">${text}</li>`)
    .join('');
  return [
    '<div class="card">',
    `<a href="${url}"></a>`,
    '<time datetime="2026-08-18T10:00:00Z">2026年08月18日</time>',
    `<a href="${url}">タイトル ${String(n)}</a>`,
    `<button aria-haspopup="dialog" aria-label="ユーザーを管理" aria-controls="${menuId}"></button>`,
    `<ul role="menu" id="${menuId}">${menuItems}</ul>`,
    '</div>',
  ].join('');
}

/** メニュー項目ごとのクリック回数を記録する。**誤爆の検査に使う** */
function trackClicks(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of document.querySelectorAll<HTMLElement>(SELECTORS.menuItem)) {
    const label = item.dataset.label ?? '';
    counts.set(label, 0);
    item.addEventListener('click', () => {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    });
  }
  return counts;
}

/** クリックされた項目のうち回数が 1 以上のものだけ */
function clicked(counts: Map<string, number>): string[] {
  return [...counts.entries()].filter(([, n]) => n > 0).map(([label]) => label);
}

/** ミュート項目を押したら Snackbar が出る、という Qiita 側の挙動を再現する */
function snackbarOnMuteClick(delayed = false): void {
  const item = findMuteItem(document);
  item?.addEventListener('click', () => {
    const insert = (): void => {
      document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="Snackbar-react-component-abc"><div aria-live="polite" aria-atomic="true"><p>${SNACKBAR_TEXT.muteCompleted}</p></div></div>`,
      );
    };
    // 遅らせると MutationObserver の経路を通る。同期だと事前チェックで拾われる
    if (delayed) setTimeout(insert, 0);
    else insert();
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('muteAuthor', () => {
  it('「投稿ユーザーをミュート」だけをクリックする', async () => {
    // Arrange
    document.body.innerHTML = cardWithMenu(1);
    const counts = trackClicks();
    snackbarOnMuteClick();
    // Act
    const outcome = await muteAuthor('example-author-1', document, FAST_TIMEOUT_MS);
    // Assert
    expect(outcome).toBe('muted');
    expect(clicked(counts)).toEqual([MENU_TEXT.mute]);
  });

  /**
   * ⚠️ **これが落ちたら絶対にマージしない。**
   * ブロックは native alert() を起動し、解除用の一覧 URL も存在しない。
   */
  it('ブロックの項目を絶対にクリックしない', async () => {
    // Arrange
    document.body.innerHTML = cardWithMenu(1);
    const counts = trackClicks();
    snackbarOnMuteClick();
    // Act
    await muteAuthor('example-author-1', document, FAST_TIMEOUT_MS);
    // Assert
    expect(counts.get(MENU_TEXT.block)).toBe(0);
  });

  it('項目の順序が違ってもミュートを選ぶ', async () => {
    // Arrange — ミュートを先頭、ブロックを末尾にする。
    // インデックスで選ぶ実装（items[2] 等）はここで落ちる
    document.body.innerHTML = cardWithMenu(1, [
      MENU_TEXT.mute,
      '投稿ユーザーをフォロー',
      MENU_TEXT.block,
    ]);
    const counts = trackClicks();
    snackbarOnMuteClick();
    // Act
    const outcome = await muteAuthor('example-author-1', document, FAST_TIMEOUT_MS);
    // Assert
    expect(outcome).toBe('muted');
    expect(clicked(counts)).toEqual([MENU_TEXT.mute]);
  });

  it('「ミュートを解除」しか無ければ何もクリックしない', async () => {
    // Arrange — 既にミュート済みの状態。**解除の文言も「ミュート」を含む**ので、
    // includes で選ぶ実装はここで解除を押してしまう
    document.body.innerHTML = cardWithMenu(1, [
      '投稿ユーザーをフォロー',
      MENU_TEXT.block,
      UNMUTE_TEXT,
    ]);
    const counts = trackClicks();
    // Act
    const outcome = await muteAuthor('example-author-1', document, FAST_TIMEOUT_MS);
    // Assert
    expect(outcome).toBe('menu-unavailable');
    expect(clicked(counts)).toEqual([]);
  });

  it('ミュートの文言を「含むだけ」の項目は押さない', async () => {
    // Arrange — 完全一致であることを直接固定する。
    //
    // 上の「ミュートを解除」テストだけでは足りない。**解除の実際の文言は
    // 意図的に測っていない**（知ると押す経路ができる）ため、あのフィクスチャは
    // 推測でしかなく、たまたま MENU_TEXT.mute を部分文字列として含まない。
    // ここは推測に依存せず、「含むだけの項目は押さない」という性質を固定する
    document.body.innerHTML = cardWithMenu(1, [MENU_TEXT.block, `${MENU_TEXT.mute}を解除`]);
    const counts = trackClicks();
    // Act
    const outcome = await muteAuthor('example-author-1', document, FAST_TIMEOUT_MS);
    // Assert
    expect(outcome).toBe('menu-unavailable');
    expect(clicked(counts)).toEqual([]);
  });

  it('カードが無ければ not-on-page を返す', async () => {
    document.body.innerHTML = '';
    await expect(muteAuthor('example-author-1', document, FAST_TIMEOUT_MS)).resolves.toBe(
      'not-on-page',
    );
  });

  it('別の著者のカードしか無ければ not-on-page を返す', async () => {
    document.body.innerHTML = cardWithMenu(2);
    await expect(muteAuthor('example-author-1', document, FAST_TIMEOUT_MS)).resolves.toBe(
      'not-on-page',
    );
  });

  it('三点メニューのボタンが無ければ menu-unavailable を返す', async () => {
    // Arrange — ボタンだけ抜いたカード
    document.body.innerHTML = cardWithMenu(1).replace(/<button[^>]*><\/button>/, '');
    // Act & Assert
    await expect(muteAuthor('example-author-1', document, FAST_TIMEOUT_MS)).resolves.toBe(
      'menu-unavailable',
    );
  });

  it('aria-controls が無ければ、カード内にメニューがあっても掴まない', async () => {
    // Arrange — 当て推量で [role="menu"] を探す実装だと、ここでミュートを押してしまう
    document.body.innerHTML = cardWithMenu(1).replace(/ aria-controls="[^"]*"/, '');
    const counts = trackClicks();
    // Act
    const outcome = await muteAuthor('example-author-1', document, FAST_TIMEOUT_MS);
    // Assert
    expect(outcome).toBe('menu-unavailable');
    expect(clicked(counts)).toEqual([]);
  });

  it('aria-controls の id にコロンが含まれていても辿れる', async () => {
    // Arrange — React の useId は `:r1:` 形式。`#${id}` は SyntaxError になる
    document.body.innerHTML = cardWithMenu(1, DEFAULT_ITEMS, ':r42:');
    snackbarOnMuteClick();
    // Act & Assert
    await expect(muteAuthor('example-author-1', document, FAST_TIMEOUT_MS)).resolves.toBe('muted');
  });

  it('aria-controls の指す id が存在しなければ menu-unavailable を返す', async () => {
    // Arrange — 属性はあるが、その id のメニューが描画されていない
    document.body.innerHTML = cardWithMenu(1).replace(
      'aria-controls=":r1:"',
      'aria-controls=":r9:"',
    );
    const counts = trackClicks();
    // Act
    const outcome = await muteAuthor('example-author-1', document, FAST_TIMEOUT_MS);
    // Assert — 別のメニューを掴んで押したりしない
    expect(outcome).toBe('menu-unavailable');
    expect(clicked(counts)).toEqual([]);
  });

  it('同じ著者の記事が 2 本あってもメニューは 1 度しか開かない', async () => {
    // Arrange — 同じ著者の 2 枚。ミュートは 1 回で足りる
    document.body.innerHTML =
      cardWithMenu(1, DEFAULT_ITEMS, ':r1:', 'example-author-1') +
      cardWithMenu(2, DEFAULT_ITEMS, ':r2:', 'example-author-1');
    let opened = 0;
    for (const button of document.querySelectorAll<HTMLElement>(SELECTORS.cardMenuButton)) {
      button.addEventListener('click', () => {
        opened += 1;
      });
    }
    snackbarOnMuteClick();
    // Act
    await muteAuthor('example-author-1', document, FAST_TIMEOUT_MS);
    // Assert
    expect(opened).toBe(1);
  });
});

/**
 * Phase 7 の非表示と競合する。「妥当」を押すと非表示とミュートが同時に走り、
 * **順序が保証されない**。カードが display:none のまま操作すると、
 * 実機でしか出ない不具合の温床になる。
 */
describe('muteAuthor と Phase 7 の非表示', () => {
  it('隠れているカードでも、メニューを開く瞬間は表示に戻っている', async () => {
    // Arrange — Phase 7 が隠したあとの状態を作る
    document.body.innerHTML = cardWithMenu(1);
    const card = document.querySelector<HTMLElement>('.card');
    if (!card) throw new Error('card not found');
    concealCard(card);
    const displayAtClick: string[] = [];
    card.querySelector(SELECTORS.cardMenuButton)?.addEventListener('click', () => {
      displayAtClick.push(card.style.display);
    });
    snackbarOnMuteClick();
    // Act
    await muteAuthor('example-author-1', document, FAST_TIMEOUT_MS);
    // Assert — display:none のまま操作していたら '' にならない
    expect(displayAtClick).toEqual(['']);
  });

  it('ミュートのあとカードは隠れた状態に戻る', async () => {
    // Arrange
    document.body.innerHTML = cardWithMenu(1);
    const card = document.querySelector<HTMLElement>('.card');
    if (!card) throw new Error('card not found');
    concealCard(card);
    snackbarOnMuteClick();
    // Act
    await muteAuthor('example-author-1', document, FAST_TIMEOUT_MS);
    // Assert
    expect(card.style.display).toBe('none');
    expect(card.dataset.qtgHidden).toBe('true');
  });

  it('失敗しても隠れた状態に戻る', async () => {
    // Arrange — メニューが取れない状態。finally が無いと表示されたままになる
    document.body.innerHTML = cardWithMenu(1).replace(/<button[^>]*><\/button>/, '');
    const card = document.querySelector<HTMLElement>('.card');
    if (!card) throw new Error('card not found');
    concealCard(card);
    // Act
    await muteAuthor('example-author-1', document, FAST_TIMEOUT_MS);
    // Assert
    expect(card.style.display).toBe('none');
  });

  it('隠れていなかったカードは、そのまま表示のままにする', async () => {
    // Arrange
    document.body.innerHTML = cardWithMenu(1);
    const card = document.querySelector<HTMLElement>('.card');
    if (!card) throw new Error('card not found');
    snackbarOnMuteClick();
    // Act
    await muteAuthor('example-author-1', document, FAST_TIMEOUT_MS);
    // Assert — 拡張が隠していないものを隠してはいけない
    expect(card.style.display).toBe('');
    expect(card.dataset.qtgHidden).toBeUndefined();
  });
});

describe('waitForSnackbar', () => {
  it('あとから現れた Snackbar を検知する', async () => {
    // Arrange & Act — MutationObserver の経路
    const waiting = waitForSnackbar(SNACKBAR_TEXT.muteCompleted, document, 1000);
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div id="Snackbar-react-component-abc"><div aria-live="polite" aria-atomic="true"><p>${SNACKBAR_TEXT.muteCompleted}</p></div></div>`,
    );
    // Assert
    await expect(waiting).resolves.toBe(true);
  });

  it('既に出ていれば待たずに true を返す', async () => {
    document.body.innerHTML = `<div id="Snackbar-react-component-abc"><div aria-live="polite" aria-atomic="true"><p>${SNACKBAR_TEXT.muteCompleted}</p></div></div>`;
    await expect(waitForSnackbar(SNACKBAR_TEXT.muteCompleted, document, 1000)).resolves.toBe(true);
  });

  it('時間内に出なければ false を返す', async () => {
    await expect(
      waitForSnackbar(SNACKBAR_TEXT.muteCompleted, document, FAST_TIMEOUT_MS),
    ).resolves.toBe(false);
  });

  it('別のメッセージでは反応しない', async () => {
    // Arrange — 解除の Snackbar が出ても、ミュート完了とは見なさない
    const waiting = waitForSnackbar(SNACKBAR_TEXT.muteCompleted, document, FAST_TIMEOUT_MS);
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div id="Snackbar-react-component-abc"><div aria-live="polite" aria-atomic="true"><p>${SNACKBAR_TEXT.unmuteCompleted}</p></div></div>`,
    );
    await expect(waiting).resolves.toBe(false);
  });
});

describe('muteAuthor の完了検知', () => {
  it('Snackbar があとから出れば muted を返す', async () => {
    // Arrange — MutationObserver の経路を通す
    document.body.innerHTML = cardWithMenu(1);
    snackbarOnMuteClick(true);
    // Act & Assert
    await expect(muteAuthor('example-author-1', document, 1000)).resolves.toBe('muted');
  });

  it('Snackbar が出なければ timeout を返す', async () => {
    // Arrange — クリックしても何も起きない（Qiita 側の変更や通信失敗）
    document.body.innerHTML = cardWithMenu(1);
    // Act & Assert — 押してはいるので、成功したかどうかは分からない
    await expect(muteAuthor('example-author-1', document, FAST_TIMEOUT_MS)).resolves.toBe(
      'timeout',
    );
  });
});

describe('findAuthorCard', () => {
  it('隠れているカードも返す', () => {
    // Arrange — Phase 7 が隠したあとでもミュートできなければならない
    document.body.innerHTML = cardWithMenu(1);
    const card = document.querySelector<HTMLElement>('.card');
    if (!card) throw new Error('card not found');
    concealCard(card);
    // Act & Assert
    expect(findAuthorCard('example-author-1')).toBe(card);
  });

  it('居なければ null を返し、例外を投げない', () => {
    document.body.innerHTML = '';
    expect(() => findAuthorCard('example-author-1')).not.toThrow();
    expect(findAuthorCard('example-author-1')).toBeNull();
  });
});

describe('findMuteItem', () => {
  it('前後の空白を無視して完全一致する', () => {
    // Arrange — React の改行込みのテキストを模す
    document.body.innerHTML = `<ul role="menu"><li role="menuitem">\n  ${MENU_TEXT.mute}\n</li></ul>`;
    // Act & Assert
    expect(findMuteItem(document)?.textContent?.trim()).toBe(MENU_TEXT.mute);
  });

  it('項目が 1 つも無ければ null を返す', () => {
    document.body.innerHTML = '<ul role="menu"></ul>';
    expect(findMuteItem(document)).toBeNull();
  });
});
