import { describe, it, expect, beforeEach } from 'vitest';
import { muteAuthor, findAuthorCard, findMuteItem, waitForSnackbar } from './muter';
import { concealCard } from './hider';
import { SELECTORS, MENU_TEXT, SNACKBAR_TEXT } from './selectors';

/**
 * Material Symbols のリガチャ。**アイコンはテキストとして項目の先頭に入る。**
 * 2026-08-24 の実機で textContent が `volume_off投稿ユーザーをミュート` だった。
 * ここを再現しないと、完全一致で書いた実装が実機で必ず失敗するのに気づけない。
 */
const ICON = {
  follow: 'add_circle',
  block: 'block',
  mute: 'volume_off',
  unmute: 'volume_up',
} as const;

interface MenuItemSpec {
  key: string;
  /** アイコンのリガチャ。空文字ならアイコン無し */
  icon: string;
  label: string;
}

const ITEM = {
  follow: { key: 'follow', icon: ICON.follow, label: '投稿ユーザーをフォロー' },
  block: { key: 'block', icon: ICON.block, label: MENU_TEXT.block },
  mute: { key: 'mute', icon: ICON.mute, label: MENU_TEXT.mute },
  /** アイコンが無い素のラベル。将来アイコンを外されても動くこと */
  mutePlain: { key: 'mute-plain', icon: '', label: MENU_TEXT.mute },
  /**
   * 既にミュート済みのときに出る側。
   *
   * **`MENU_TEXT.unmute` を参照せず実測値を直書きする。**定数を使うと、
   * 定数そのものを書き換える変異を検査できなくなる（実装とテストが同じ値を
   * 見て一致してしまう）。2026-08-29 に実装もこの文言を持つようになったが、
   * **テスト側は独立した実測値のままにしておく。**
   */
  unmute: { key: 'unmute', icon: ICON.unmute, label: '投稿ユーザーのミュートを解除' },
  /** 接尾辞が付いた形。**includes で選ぶ実装はここで解除を押す** */
  muteSuffixed: { key: 'mute-suffixed', icon: ICON.unmute, label: `${MENU_TEXT.mute}を解除` },
} as const satisfies Record<string, MenuItemSpec>;

/** 実測の textContent。アイコンのリガチャがラベルの前に付く */
function textOf(spec: MenuItemSpec): string {
  return `${spec.icon}${spec.label}`;
}

/** 実測どおりの並び。**ブロックがミュートの直上**にある */
const DEFAULT_ITEMS: MenuItemSpec[] = [ITEM.follow, ITEM.block, ITEM.mute];

/** ミュートを押したときに Snackbar を出す項目 */
const SNACKBAR_KEYS = new Set(['mute', 'mute-plain']);

/** メニューや Snackbar が現れるのを待つぶん */
const TIMEOUT_MS = 200;
/** 現れないことを確かめるぶん */
const GIVE_UP_MS = 20;

/** 押された順序。`open-1` / `mute-1` の形で積む */
const clicks: string[] = [];

/** メニュー項目のクリックだけ（メニューを開いた操作は除く） */
function itemClicks(): string[] {
  return clicks.filter((entry) => !entry.startsWith('open-'));
}

function showSnackbar(text: string = SNACKBAR_TEXT.muteCompleted): void {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="Snackbar-react-component-abc"><div aria-live="polite" aria-atomic="true"><p>${text}</p></div></div>`,
  );
}

interface CardOptions {
  author?: string;
  items?: MenuItemSpec[];
  menuId?: string;
  /** aria-controls に入れる値。null なら属性ごと付けない */
  controls?: string | null;
  /** 三点メニューのボタンを付けない */
  noButton?: boolean;
  /** メニューが現れるまでの遅延（ミリ秒）。null なら押しても現れない */
  menuDelayMs?: number | null;
  /** 最初からメニューを DOM に置く（当て推量をしないことの検査用） */
  eager?: boolean;
  /** ミュートを押しても Snackbar を出さない */
  noSnackbar?: boolean;
  /** 項目に button を入れず、器そのものを押せる形にする（フォールバックの検査用） */
  noActionButton?: boolean;
}

/**
 * トレンドカード 1 枚を実測どおりに組み立てる。
 *
 * **メニューは最初 DOM に無い。**React は状態更新を同期で描画しないため、
 * ボタンを押した「あと」に現れる（実機: click 直後 0 件 → 300ms 後 1 件）。
 * ここを再現しないと、同期で読む実装が通ってしまう。
 *
 * 記事リンクは実測どおり 2 本。フィクスチャは合成値のみで、
 * 実アカウント名・実 item_id は使わない。
 */
function mountCard(n: number, options: CardOptions = {}): HTMLElement {
  const {
    author = `example-author-${String(n)}`,
    items = DEFAULT_ITEMS,
    menuId = `:R${String(n)}elbk:`,
    controls = menuId,
    noButton = false,
    menuDelayMs = 0,
    eager = false,
    noSnackbar = false,
    noActionButton = false,
  } = options;

  const itemId = `0123456789abcdef${String(n).padStart(4, '0')}`;
  const url = `https://qiita.com/${author}/items/${itemId}`;

  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.n = String(n);
  const controlsAttr = controls === null ? '' : ` aria-controls="${controls}"`;
  card.innerHTML = [
    `<a href="${url}"></a>`,
    '<time datetime="2026-08-18T10:00:00Z">2026年08月18日</time>',
    `<a href="${url}">タイトル ${String(n)}</a>`,
    noButton
      ? ''
      : `<button aria-haspopup="dialog" aria-label="ユーザーを管理"${controlsAttr}></button>`,
  ].join('');
  document.body.append(card);

  const buildMenu = (): void => {
    if (card.querySelector(SELECTORS.cardMenu) !== null) return;
    const menu = document.createElement('ul');
    menu.setAttribute('role', 'menu');
    menu.id = menuId;
    for (const spec of items) {
      const entry = document.createElement('li');
      entry.setAttribute('role', 'menuitem');
      entry.dataset.key = spec.key;

      const onClick = (): void => {
        clicks.push(`${spec.key}-${String(n)}`);
        // Qiita は完了を Snackbar で知らせる。**遅らせるのが要点** —
        // 同期で出すと waitForDom の事前チェックで拾われ、待つ経路を通らない
        if (SNACKBAR_KEYS.has(spec.key) && !noSnackbar) {
          setTimeout(() => {
            showSnackbar();
          }, 0);
        }
      };

      if (noActionButton) {
        // 器そのものが押せる形。actionOf のフォールバック経路
        entry.textContent = textOf(spec);
        entry.addEventListener('click', onClick);
      } else {
        // 実測の形: <li role="menuitem"><button type="button"><span aria-hidden>icon</span>ラベル</button></li>
        // **リスナーは button に付ける。**器に付けると、器を押しても動く
        // 実装が通ってしまい、実機の不具合を再現できない
        const action = document.createElement('button');
        action.type = 'button';
        if (spec.icon !== '') {
          const icon = document.createElement('span');
          icon.setAttribute('aria-hidden', 'true');
          icon.textContent = spec.icon;
          action.append(icon);
        }
        action.append(spec.label);
        action.addEventListener('click', onClick);
        entry.append(action);
      }

      menu.append(entry);
    }
    card.append(menu);
  };

  if (eager) buildMenu();

  card.querySelector(SELECTORS.cardMenuButton)?.addEventListener('click', () => {
    clicks.push(`open-${String(n)}`);
    if (menuDelayMs === null) return;
    setTimeout(buildMenu, menuDelayMs);
  });

  return card;
}

beforeEach(() => {
  document.body.innerHTML = '';
  clicks.length = 0;
});

describe('muteAuthor', () => {
  it('「投稿ユーザーをミュート」だけをクリックする', async () => {
    // Arrange — 項目のテキストにはアイコンのリガチャが前に付く
    mountCard(1);
    // Act
    const outcome = await muteAuthor('example-author-1', document, TIMEOUT_MS);
    // Assert
    expect(outcome).toBe('muted');
    expect(itemClicks()).toEqual(['mute-1']);
  });

  /**
   * ⚠️ **これが落ちたら絶対にマージしない。**
   * ブロックは native alert() を起動し、解除用の一覧 URL も存在しない。
   */
  it('ブロックの項目を絶対にクリックしない', async () => {
    // Arrange
    mountCard(1);
    // Act
    await muteAuthor('example-author-1', document, TIMEOUT_MS);
    // Assert
    expect(itemClicks()).not.toContain('block-1');
  });

  it('項目の順序が違ってもミュートを選ぶ', async () => {
    // Arrange — ミュートを先頭、ブロックを末尾にする。
    // インデックスで選ぶ実装（items[2] 等）はここで落ちる
    mountCard(1, { items: [ITEM.mute, ITEM.follow, ITEM.block] });
    // Act
    const outcome = await muteAuthor('example-author-1', document, TIMEOUT_MS);
    // Assert
    expect(outcome).toBe('muted');
    expect(itemClicks()).toEqual(['mute-1']);
  });

  it('アイコンが無い素のラベルでも選ぶ', async () => {
    // Arrange — 将来アイコンを外されても動くこと
    mountCard(1, { items: [ITEM.follow, ITEM.block, ITEM.mutePlain] });
    // Act & Assert
    await expect(muteAuthor('example-author-1', document, TIMEOUT_MS)).resolves.toBe('muted');
    expect(itemClicks()).toEqual(['mute-plain-1']);
  });

  it('「ミュートを解除」しか無ければ何もクリックせず、ミュート中と判定する', async () => {
    // Arrange — 既にミュート済みの状態
    mountCard(1, { items: [ITEM.follow, ITEM.block, ITEM.unmute] });
    // Act
    const outcome = await muteAuthor('example-author-1', document, TIMEOUT_MS);
    // Assert — **押さないことは変えていない。**変わったのは「なぜ押さなかったか」を
    // 言えるようになった点だけ（2026-08-29）
    expect(outcome).toBe('already-muted');
    expect(itemClicks()).toEqual([]);
  });

  it('どちらの文言も無ければ menu-unavailable（画面構造の変化）', async () => {
    // Arrange — ミュートも解除も無い = Qiita 側が変わった
    mountCard(1, { items: [ITEM.follow, ITEM.block] });
    // Act
    const outcome = await muteAuthor('example-author-1', document, TIMEOUT_MS);
    // Assert — already-muted と混ぜない。混ぜると直すべき不具合が隠れる
    expect(outcome).toBe('menu-unavailable');
    expect(itemClicks()).toEqual([]);
  });

  it('ミュートの文言に後置きがあれば押さない', async () => {
    // Arrange — アイコンは **前** に付く。後ろに付くものは意味が変わっている。
    // includes で選ぶ実装はここで解除を押してしまう
    mountCard(1, { items: [ITEM.block, ITEM.muteSuffixed] });
    // Act
    const outcome = await muteAuthor('example-author-1', document, TIMEOUT_MS);
    // Assert
    expect(outcome).toBe('menu-unavailable');
    expect(itemClicks()).toEqual([]);
  });

  it('カードが無ければ not-on-page を返す', async () => {
    await expect(muteAuthor('example-author-1', document, TIMEOUT_MS)).resolves.toBe('not-on-page');
  });

  it('別の著者のカードしか無ければ not-on-page を返す', async () => {
    mountCard(2);
    await expect(muteAuthor('example-author-1', document, TIMEOUT_MS)).resolves.toBe('not-on-page');
  });

  it('三点メニューのボタンが無ければ menu-unavailable を返す', async () => {
    mountCard(1, { noButton: true });
    await expect(muteAuthor('example-author-1', document, GIVE_UP_MS)).resolves.toBe(
      'menu-unavailable',
    );
  });

  it('aria-controls が無ければ、カード内にメニューがあっても掴まない', async () => {
    // Arrange — 当て推量で [role="menu"] を探す実装だと、ここでミュートを押してしまう
    mountCard(1, { controls: null, eager: true });
    // Act
    const outcome = await muteAuthor('example-author-1', document, GIVE_UP_MS);
    // Assert
    expect(outcome).toBe('menu-unavailable');
    expect(itemClicks()).toEqual([]);
  });

  it('aria-controls の id にコロンが含まれていても辿れる', async () => {
    // Arrange — React の生成 ID は `:Relbk39a:` 形式。`#${id}` は SyntaxError になる
    mountCard(1, { menuId: ':Relbk39a:' });
    // Act & Assert
    await expect(muteAuthor('example-author-1', document, TIMEOUT_MS)).resolves.toBe('muted');
  });

  it('aria-controls の指す id のメニューが現れなければ menu-unavailable を返す', async () => {
    // Arrange — 属性はあるが、別の id のメニューしか出てこない
    mountCard(1, { menuId: ':R1elbk:', controls: ':R9nope:' });
    // Act
    const outcome = await muteAuthor('example-author-1', document, GIVE_UP_MS);
    // Assert — 別のメニューを掴んで押したりしない
    expect(outcome).toBe('menu-unavailable');
    expect(itemClicks()).toEqual([]);
  });

  it('同じ著者の記事が 2 本あってもメニューは 1 度しか開かない', async () => {
    // Arrange — 同じ著者の 2 枚。ミュートは 1 回で足りる
    mountCard(1, { author: 'example-author-1' });
    mountCard(2, { author: 'example-author-1' });
    // Act
    await muteAuthor('example-author-1', document, TIMEOUT_MS);
    // Assert
    expect(clicks.filter((entry) => entry.startsWith('open-'))).toEqual(['open-1']);
  });
});

/**
 * ★ **2026-08-24 の実機で見つかった不具合の番人。**
 *
 * React は状態更新を同期で描画しない。ボタンを押した直後の [role="menu"] は
 * 0 件で、300ms 後に 1 件になる。**同期で読む実装は実機で必ず失敗する。**
 *
 * それまでのフィクスチャはメニューを最初から DOM に置いていたため、
 * この経路は一度も検査されていなかった。
 */
describe('muteAuthor とメニューの非同期描画', () => {
  it('押した直後には無くても、現れたら掴む', async () => {
    // Arrange — 実機と同じく、押したあとに描画される
    mountCard(1, { menuDelayMs: 10 });
    // Act
    const outcome = await muteAuthor('example-author-1', document, TIMEOUT_MS);
    // Assert
    expect(outcome).toBe('muted');
    expect(itemClicks()).toEqual(['mute-1']);
  });

  it('押した瞬間はまだメニューが DOM に無い（フィクスチャ自身の確認）', () => {
    // Arrange & Act — フィクスチャが実機を再現できていることを固定する
    const card = mountCard(1, { menuDelayMs: 10 });
    card.querySelector<HTMLElement>(SELECTORS.cardMenuButton)?.click();
    // Assert — ここが最初から 1 件になっていると、テストが実機と別物になる
    expect(document.querySelectorAll(SELECTORS.cardMenu)).toHaveLength(0);
  });

  it('時間内に現れなければ menu-unavailable を返す', async () => {
    // Arrange — 押しても開かない（Qiita の画面構造が変わった等）
    mountCard(1, { menuDelayMs: null });
    // Act & Assert
    await expect(muteAuthor('example-author-1', document, GIVE_UP_MS)).resolves.toBe(
      'menu-unavailable',
    );
    expect(itemClicks()).toEqual([]);
  });
});

/**
 * ★ **2026-08-24 の実機で見つかった 2 つめの不具合の番人。**
 *
 * `[role="menuitem"]` は器で、ハンドラは中の `<button>` にある。
 * イベントは下へ伝播しないので、器を押しても何も起きない。
 * 実機では「押したのに Snackbar が出ない」（timeout）になっていた。
 */
describe('muteAuthor が押す要素', () => {
  it('器（li）ではなく中の button を押す', async () => {
    // Arrange
    const card = mountCard(1);
    // Act
    const outcome = await muteAuthor('example-author-1', document, TIMEOUT_MS);
    // Assert — 押された要素が BUTTON であること
    expect(outcome).toBe('muted');
    const pressed = card.querySelector<HTMLElement>('[role="menuitem"] button');
    expect(pressed?.tagName).toBe('BUTTON');
    expect(itemClicks()).toEqual(['mute-1']);
  });

  it('器を押しても何も起きない（フィクスチャ自身の確認）', async () => {
    // Arrange — メニューを開いておく
    const card = mountCard(1);
    card.querySelector<HTMLElement>(SELECTORS.cardMenuButton)?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const item = card.querySelector<HTMLElement>('[role="menuitem"][data-key="mute"]');
    // Act — 器を直接押す（実機で失敗していた実装と同じこと）
    item?.click();
    // Assert — ここが反応してしまうと、この不具合を再現できない
    expect(itemClicks()).toEqual([]);
  });

  it('button が無ければ器そのものを押す', async () => {
    // Arrange — 器自体が押せる形に変わっても動くこと
    mountCard(1, { noActionButton: true });
    // Act & Assert
    await expect(muteAuthor('example-author-1', document, TIMEOUT_MS)).resolves.toBe('muted');
    expect(itemClicks()).toEqual(['mute-1']);
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
    const card = mountCard(1);
    concealCard(card);
    const displayAtClick: string[] = [];
    card.querySelector(SELECTORS.cardMenuButton)?.addEventListener('click', () => {
      displayAtClick.push(card.style.display);
    });
    // Act
    await muteAuthor('example-author-1', document, TIMEOUT_MS);
    // Assert — display:none のまま操作していたら '' にならない
    expect(displayAtClick).toEqual(['']);
  });

  it('ミュートのあとカードは隠れた状態に戻る', async () => {
    // Arrange
    const card = mountCard(1);
    concealCard(card);
    // Act
    await muteAuthor('example-author-1', document, TIMEOUT_MS);
    // Assert
    expect(card.style.display).toBe('none');
    expect(card.dataset.qtgHidden).toBe('true');
  });

  it('失敗しても隠れた状態に戻る', async () => {
    // Arrange — メニューが取れない状態。finally が無いと表示されたままになる
    const card = mountCard(1, { noButton: true });
    concealCard(card);
    // Act
    await muteAuthor('example-author-1', document, GIVE_UP_MS);
    // Assert
    expect(card.style.display).toBe('none');
  });

  it('隠れていなかったカードは、そのまま表示のままにする', async () => {
    // Arrange
    const card = mountCard(1);
    // Act
    await muteAuthor('example-author-1', document, TIMEOUT_MS);
    // Assert — 拡張が隠していないものを隠してはいけない
    expect(card.style.display).toBe('');
    expect(card.dataset.qtgHidden).toBeUndefined();
  });
});

describe('waitForSnackbar', () => {
  it('あとから現れた Snackbar を検知する', async () => {
    // Arrange & Act — MutationObserver の経路
    const waiting = waitForSnackbar(SNACKBAR_TEXT.muteCompleted, document, TIMEOUT_MS);
    showSnackbar();
    // Assert
    await expect(waiting).resolves.toBe(true);
  });

  it('既に出ていれば待たずに true を返す', async () => {
    showSnackbar();
    await expect(waitForSnackbar(SNACKBAR_TEXT.muteCompleted, document, TIMEOUT_MS)).resolves.toBe(
      true,
    );
  });

  it('時間内に出なければ false を返す', async () => {
    await expect(waitForSnackbar(SNACKBAR_TEXT.muteCompleted, document, GIVE_UP_MS)).resolves.toBe(
      false,
    );
  });

  it('別のメッセージでは反応しない', async () => {
    // Arrange — 解除の Snackbar が出ても、ミュート完了とは見なさない
    const waiting = waitForSnackbar(SNACKBAR_TEXT.muteCompleted, document, GIVE_UP_MS);
    showSnackbar(SNACKBAR_TEXT.unmuteCompleted);
    await expect(waiting).resolves.toBe(false);
  });
});

describe('muteAuthor の完了検知', () => {
  it('Snackbar が出なければ timeout を返す', async () => {
    // Arrange — 押してはいるので、成功したかどうかは分からない
    mountCard(1, { noSnackbar: true });
    // Act & Assert
    await expect(muteAuthor('example-author-1', document, GIVE_UP_MS)).resolves.toBe('timeout');
    expect(itemClicks()).toEqual(['mute-1']);
  });
});

describe('findAuthorCard', () => {
  it('隠れているカードも返す', () => {
    // Arrange — Phase 7 が隠したあとでもミュートできなければならない
    const card = mountCard(1);
    concealCard(card);
    // Act & Assert
    expect(findAuthorCard('example-author-1')).toBe(card);
  });

  it('居なければ null を返し、例外を投げない', () => {
    expect(() => findAuthorCard('example-author-1')).not.toThrow();
    expect(findAuthorCard('example-author-1')).toBeNull();
  });
});

describe('findMuteItem', () => {
  function menuWith(...texts: string[]): void {
    const entries = texts.map((text) => `<li role="menuitem">${text}</li>`).join('');
    document.body.innerHTML = `<ul role="menu">${entries}</ul>`;
  }

  it('アイコンのリガチャが前に付いていても選ぶ', () => {
    // Arrange — 実測の textContent
    menuWith(textOf(ITEM.mute));
    // Act & Assert
    expect(findMuteItem(document)?.textContent).toBe(textOf(ITEM.mute));
  });

  it('前後の空白を無視する', () => {
    menuWith(`\n  ${MENU_TEXT.mute}\n`);
    expect(findMuteItem(document)?.textContent?.trim()).toBe(MENU_TEXT.mute);
  });

  it('後置きが付いた項目は選ばない', () => {
    menuWith(textOf(ITEM.muteSuffixed));
    expect(findMuteItem(document)).toBeNull();
  });

  it('ブロックの項目は選ばない', () => {
    menuWith(textOf(ITEM.block));
    expect(findMuteItem(document)).toBeNull();
  });

  it('項目が 1 つも無ければ null を返す', () => {
    document.body.innerHTML = '<ul role="menu"></ul>';
    expect(findMuteItem(document)).toBeNull();
  });
});
