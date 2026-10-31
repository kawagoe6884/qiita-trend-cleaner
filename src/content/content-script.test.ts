import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveAiHintPrefs,
  saveAiHints,
  saveAiVerdict,
  saveToken,
  saveVerdict,
  getAiVerdicts,
} from '../lib/storage';
import { SELECTORS, MENU_TEXT, SNACKBAR_TEXT } from '../dom/selectors';
import type { AiAnswer, AiHint } from '../types/domain';

/** chrome は setup.ts が各テストの前に用意する。トップレベルではまだ未定義 */
function sendMessageMock() {
  return vi.mocked(chrome.runtime.sendMessage);
}

/**
 * 1 カード分の骨格。実測どおり記事リンクを 2 本持たせる。
 * フィクスチャは合成値のみ。実アカウント名・実 item_id は使わない。
 */
function card(n: number, author = `example-author-${String(n)}`): string {
  const itemId = `0123456789abcdef${String(n).padStart(4, '0')}`;
  const url = `https://qiita.com/${author}/items/${itemId}`;
  return `<div class="card"><a href="${url}"></a><time datetime="2026-08-18T10:00:00Z">2026年08月18日</time><a href="${url}">タイトル ${String(n)}</a></div>`;
}

/** 表示中のカード数 */
function visibleCards(): number {
  return [...document.querySelectorAll<HTMLElement>('.card')].filter(
    (el) => el.style.display !== 'none',
  ).length;
}

/** 押した順序。`open-1` / `mute-1` の形で積む。**直列化の検査に使う** */
const sequence: string[] = [];

/**
 * 三点メニュー付きのカードを 1 枚置く。**メニューは最初 DOM に無い。**
 *
 * React は状態更新を同期で描画しないため、ボタンを押した「あと」に現れる
 * （2026-08-24 実機: click 直後 0 件 → 300ms 後 1 件）。項目のテキストには
 * Material Symbols のリガチャが**前に**付く（`volume_off投稿ユーザーをミュート`）。
 * どちらもここで再現しないと、実機で必ず失敗する実装が通ってしまう。
 *
 * 実測どおり「フォロー / **ブロック** / ミュート」の順にする。
 */
function mountCardWithMenu(
  n: number,
  author = `example-author-${String(n)}`,
  /** Snackbar が出るまでの時間。カードの描き直しの待ち時間より長いミュートを再現する */
  snackbarDelayMs = 0,
): void {
  const itemId = `0123456789abcdef${String(n).padStart(4, '0')}`;
  const url = `https://qiita.com/${author}/items/${itemId}`;
  const menuId = `:R${String(n)}elbk:`;

  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.n = String(n);
  card.innerHTML = [
    `<a href="${url}"></a>`,
    '<time datetime="2026-08-18T10:00:00Z">2026年08月18日</time>',
    `<a href="${url}">タイトル ${String(n)}</a>`,
    `<button aria-haspopup="dialog" aria-label="ユーザーを管理" aria-controls="${menuId}"></button>`,
  ].join('');
  document.body.append(card);

  const entries = [
    { key: 'follow', icon: 'add_circle', label: '投稿ユーザーをフォロー' },
    { key: 'OTHER', icon: 'block', label: MENU_TEXT.block },
    { key: 'mute', icon: 'volume_off', label: MENU_TEXT.mute },
  ];

  card.querySelector(SELECTORS.cardMenuButton)?.addEventListener('click', () => {
    sequence.push(`open-${String(n)}`);
    if (card.querySelector(SELECTORS.cardMenu) !== null) return;
    setTimeout(() => {
      const menu = document.createElement('ul');
      menu.setAttribute('role', 'menu');
      menu.id = menuId;
      for (const spec of entries) {
        const entry = document.createElement('li');
        entry.setAttribute('role', 'menuitem');
        // 実測の形: <li role="menuitem"><button type="button"><span aria-hidden>icon</span>ラベル</button></li>
        // **リスナーは button に付ける。**器に付けると、器を押しても動く実装が
        // 通ってしまい、実機の不具合を再現できない
        const action = document.createElement('button');
        action.type = 'button';
        const icon = document.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = spec.icon;
        action.append(icon, spec.label);
        action.addEventListener('click', () => {
          sequence.push(`${spec.key}-${String(n)}`);
          // Qiita は完了を Snackbar で知らせる。**遅らせるのが要点** —
          // 同期で出すと待つ経路を通らず、直列化していない実装でも同じ順序になる
          setTimeout(() => {
            document.body.insertAdjacentHTML(
              'beforeend',
              `<div id="Snackbar-react-component-abc"><div aria-live="polite" aria-atomic="true"><p>${SNACKBAR_TEXT.muteCompleted}</p></div></div>`,
            );
          }, snackbarDelayMs);
        });
        entry.append(action);
        menu.append(entry);
      }
      card.append(menu);
    }, 0);
  });
}

/** onMessage に登録されたリスナーを取り出す */
function messageListener() {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]?.[0];
  if (!listener) throw new Error('message listener not registered');
  return listener;
}

/** ミュートを依頼し、応答を受け取る spy とリスナーの戻り値を返す */
function requestMute(handle: string) {
  const sendResponse = vi.fn();
  const returned = messageListener()({ type: 'MUTE_AUTHOR', handle }, {}, sendResponse);
  return { sendResponse, returned };
}

/** storage.onChanged に登録されたリスナーを取り出す */
function storageListener() {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0]?.[0];
  if (!listener) throw new Error('storage listener not registered');
  return listener;
}

/**
 * content script は import しただけでトップレベルの処理が走る。
 * モジュールキャッシュが効くと 2 件目以降で観測できないため毎回リセットする
 * （service-worker.test.ts と同じ手法）。
 *
 * pathname は jsdom の URL で決まるので、テストごとに書き換える。
 */
async function bootContentScript(pathname = '/trend'): Promise<void> {
  window.history.replaceState({}, '', pathname);
  vi.resetModules();
  await import('./content-script');
  // トップレベルの async 処理（storage の読み込み）が終わるのを待つ
  await vi.waitFor(() => {
    expect(sendMessageMock()).toHaveBeenCalled();
  });
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  // body ごと差し替える。前のテストで起動した content script の監視は古い body に
  // 付いたまま残るので、こうしないと**前のテストの content script が次のテストの
  // DOM を書き換える**（「表示する」で戻した状態を、別の content script が隠し直す等）
  document.body.replaceWith(document.createElement('body'));
  sequence.length = 0;
  // @types/chrome の sendMessage は 5 つのオーバーロードを持ち、vi.mocked が
  // void を返すシグネチャを拾う。実行時には正しい応答が返るので、ここだけ型を黙らせる
  sendMessageMock().mockResolvedValue({ type: 'PONG', version: '0.0.0-test' } as never);
});

describe('content script の非表示', () => {
  it('妥当と評価された著者のカードを隠す', async () => {
    // Arrange
    document.body.innerHTML = card(1) + card(2);
    await saveVerdict('example-author-1', 'valid');
    // Act
    await bootContentScript();
    // Assert
    await vi.waitFor(() => {
      expect(visibleCards()).toBe(1);
    });
  });

  it('評価が無ければ何も隠さない', async () => {
    // Arrange
    document.body.innerHTML = card(1) + card(2);
    // Act
    await bootContentScript();
    // Assert
    expect(visibleCards()).toBe(2);
  });

  it('トレンド以外のページでは何もしない', async () => {
    // Arrange — プロフィールページにも記事リンクと <time> が揃っている
    document.body.innerHTML = card(1) + card(2);
    await saveVerdict('example-author-1', 'valid');
    // Act
    await bootContentScript('/example-author-1');
    // Assert — ページを絞らないと、トレンドでない記事まで消える
    expect(visibleCards()).toBe(2);
  });

  it('隠した件数の案内を出す', async () => {
    // Arrange
    document.body.innerHTML = card(1);
    await saveVerdict('example-author-1', 'valid');
    // Act
    await bootContentScript();
    // Assert
    await vi.waitFor(() => {
      expect(document.querySelector('#qtg-hidden-notice')?.textContent).toContain('1 件を非表示中');
    });
  });

  it('隠すものが無ければ案内を出さない', async () => {
    document.body.innerHTML = card(1);
    await bootContentScript();
    expect(document.querySelector('#qtg-hidden-notice')).toBeNull();
  });
});

/**
 * ポップアップと content script は別コンテキストだが storage は共有されている。
 * message passing を使わずに追従する。
 */
describe('content script の評価変更への追従', () => {
  it('妥当に変わったら隠す', async () => {
    // Arrange — 最初は評価が無い
    document.body.innerHTML = card(1) + card(2);
    await bootContentScript();
    expect(visibleCards()).toBe(2);
    // Act — ポップアップで「妥当」を押した状況
    await saveVerdict('example-author-1', 'valid');
    storageListener()({ feedback: { newValue: { 'example-author-1': 'valid' } } }, 'local');
    // Assert
    await vi.waitFor(() => {
      expect(visibleCards()).toBe(1);
    });
  });

  it('誤りに押し直したら戻る', async () => {
    // Arrange — 隠れている状態から始める
    document.body.innerHTML = card(1) + card(2);
    await saveVerdict('example-author-1', 'valid');
    await bootContentScript();
    await vi.waitFor(() => {
      expect(visibleCards()).toBe(1);
    });
    // Act — 誤検知だったので押し直す
    await saveVerdict('example-author-1', 'false_positive');
    storageListener()({ feedback: { newValue: {} } }, 'local');
    // Assert — 差分を追わず unhideAll してから再適用するので戻る
    await vi.waitFor(() => {
      expect(visibleCards()).toBe(2);
    });
  });

  it('関係のないキーの変更では何もしない', async () => {
    // Arrange
    document.body.innerHTML = card(1);
    await bootContentScript();
    await saveVerdict('example-author-1', 'valid');
    // Act — 候補の保存など、スキャンのたびに起きる書き込み
    storageListener()({ candidates: { newValue: [] } }, 'local');
    await Promise.resolve();
    // Assert — feedback を見ていないので隠さない
    expect(visibleCards()).toBe(1);
  });
});

/**
 * 右下の通知はトグル。**2026-08-24 の実機で見つかったバグの番人。**
 *
 * 「表示する」だけを置いていたとき、押したあとに隠し直す手段が無かった。
 * ユーザーは「妥当」を押し直したが、**評価は既に valid なので storage の値が
 * 変わらず、onChanged が発火しない**（Chrome は値が実際に変わったときだけ
 * 発火する）。何も起きないように見えた。
 */
describe('content script の通知トグル', () => {
  function noticeButton(): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>('#qtg-hidden-notice button');
    if (!button) throw new Error('notice button not found');
    return button;
  }

  async function bootWithOneHidden(): Promise<void> {
    document.body.innerHTML = card(1) + card(2);
    await saveVerdict('example-author-1', 'valid');
    await bootContentScript();
    await vi.waitFor(() => {
      expect(visibleCards()).toBe(1);
    });
  }

  it('「表示する」を押すと戻り、ボタンが「隠す」に変わる', async () => {
    // Arrange
    await bootWithOneHidden();
    expect(noticeButton().textContent).toBe('表示する');
    // Act
    noticeButton().click();
    // Assert
    expect(visibleCards()).toBe(2);
    expect(noticeButton().textContent).toBe('　隠す　');
    expect(document.querySelector('#qtg-hidden-notice')?.textContent).toContain('1 件を表示中');
  });

  it('「隠す」を押すと隠し直せる', async () => {
    // Arrange — 「表示する」で戻した状態
    await bootWithOneHidden();
    noticeButton().click();
    expect(visibleCards()).toBe(2);
    // Act — ここが無いと、戻した後に隠す手段が無い
    noticeButton().click();
    // Assert
    await vi.waitFor(() => {
      expect(visibleCards()).toBe(1);
    });
    expect(noticeButton().textContent).toBe('表示する');
  });

  it('評価が変わったら「表示する」の状態を解除する', async () => {
    // Arrange — 手で戻した状態
    await bootWithOneHidden();
    noticeButton().click();
    expect(noticeButton().textContent).toBe('　隠す　');
    // Act — 別の著者に「妥当」を押した（評価が変わるので onChanged が発火する）
    await saveVerdict('example-author-2', 'valid');
    storageListener()(
      { feedback: { newValue: { 'example-author-1': 'valid', 'example-author-2': 'valid' } } },
      'local',
    );
    // Assert — 隠れ直し、ボタンも「表示する」に戻る
    await vi.waitFor(() => {
      expect(visibleCards()).toBe(0);
    });
    expect(noticeButton().textContent).toBe('表示する');
  });
});

/**
 * Qiita はページを開いた直後にカードを作り直す（2026-10-31 実機: `hidden: 4` のログのあと
 * `[data-qtg-hidden="true"]` が 0 件）。作り直されたカードには目印も display:none も無く、
 * 右下の通知だけが「○件を非表示中」のまま残っていた。
 */
describe('content script の非表示の描き直し', () => {
  function noticeText(): string {
    return document.querySelector('#qtg-hidden-notice')?.textContent ?? '';
  }

  /** Qiita がカードの一覧を丸ごと作り直した状況。右下の通知は body 直下なので残る */
  function rebuildCards(html: string): void {
    const list = document.getElementById('list');
    if (!list) throw new Error('list not found');
    list.innerHTML = html;
  }

  async function bootWithOneHidden(): Promise<void> {
    document.body.innerHTML = `<main id="list">${card(1) + card(2)}</main>`;
    await saveVerdict('example-author-1', 'valid');
    await bootContentScript();
    await vi.waitFor(() => {
      expect(visibleCards()).toBe(1);
    });
  }

  it('カードが作り直されたら、隠し直す', async () => {
    // Arrange
    await bootWithOneHidden();
    // Act
    rebuildCards(card(1) + card(2));
    // Assert
    await vi.waitFor(() => {
      expect(visibleCards()).toBe(1);
    });
  });

  it('作り直しで件数が変わったら、通知の件数も合わせる', async () => {
    // Arrange
    await bootWithOneHidden();
    expect(noticeText()).toContain('1 件を非表示中');
    // Act — 同じ著者の記事が 1 件増えた
    rebuildCards(card(1) + card(2) + card(3, 'example-author-1'));
    // Assert
    await vi.waitFor(() => {
      expect(noticeText()).toContain('2 件を非表示中');
    });
    expect(visibleCards()).toBe(1);
  });

  it('「表示する」で戻している間は、作り直されても隠さず、背景の目印は付け直す', async () => {
    // Arrange
    await bootWithOneHidden();
    document.querySelector<HTMLButtonElement>('#qtg-hidden-notice button')?.click();
    expect(visibleCards()).toBe(2);
    // Act
    rebuildCards(card(1) + card(2));
    // Assert — 目印が付け直されるまで待ち、そのときも戻したまま
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-qtg-judged="true"]')).toHaveLength(1);
    });
    expect(visibleCards()).toBe(2);
    expect(noticeText()).toContain('1 件を表示中');
  });

  it('「表示する」の状態は、作り直しの途中でカードが一時的に無くなっても解けない', async () => {
    // Arrange
    await bootWithOneHidden();
    document.querySelector<HTMLButtonElement>('#qtg-hidden-notice button')?.click();
    // Act — いったん空になり、描き直しが走ったあとでカードが戻る。
    // 時間で待つと、遅いマシンでは空の状態を通らずに通ってしまうので、storage を読んだことで待つ
    const getSpy = vi.spyOn(chrome.storage.local, 'get');
    const readsBefore = getSpy.mock.calls.length;
    rebuildCards('');
    await vi.waitFor(() => {
      expect(getSpy.mock.calls.length).toBeGreaterThan(readsBefore);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    rebuildCards(card(1) + card(2));
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-qtg-judged="true"]')).toHaveLength(1);
    });
    // Assert
    expect(visibleCards()).toBe(2);
    expect(noticeText()).toContain('1 件を表示中');
  });

  it('ミュートの最中は隠し直さず、終わったら隠し直す', async () => {
    // Arrange — 妥当と評価済みで、監視が始まっている。ミュートは描き直しの待ち時間より長くかかる
    const SLOW_SNACKBAR_MS = 600;
    mountCardWithMenu(1, 'example-author-1', SLOW_SNACKBAR_MS);
    await saveVerdict('example-author-1', 'valid');
    await bootContentScript();
    const target = document.querySelector<HTMLElement>('[data-n="1"]');
    await vi.waitFor(() => {
      expect(target?.style.display).toBe('none');
    });
    // Act — muter はメニューを押すためにカードを表示に戻す。メニューが出るのはページの変化
    const { sendResponse } = requestMute('example-author-1');
    await vi.waitFor(() => {
      expect(sequence).toContain('mute-1');
    });
    // Assert — 描き直しの待ち時間（300 ms）を過ぎても、ミュート中は隠し直さない
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(sendResponse).not.toHaveBeenCalled();
    expect(target?.style.display).not.toBe('none');
    // Assert — 終わったら隠れ直す
    await vi.waitFor(
      () => {
        expect(sendResponse).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );
    await vi.waitFor(() => {
      expect(target?.style.display).toBe('none');
    });
  });

  it('通知の書き換えには反応しない（隠し直しが止まらなくならない）', async () => {
    // Arrange
    await bootWithOneHidden();
    rebuildCards(card(1) + card(2));
    await vi.waitFor(() => {
      expect(visibleCards()).toBe(1);
    });
    const getSpy = vi.spyOn(chrome.storage.local, 'get');
    // Act — 監視の待ち時間より長く待つ
    await new Promise((resolve) => setTimeout(resolve, 600));
    const settled = getSpy.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Assert — 落ち着いたあとは storage を読みに行かない
    expect(getSpy.mock.calls.length).toBe(settled);
  });
});

/**
 * 背景の目印は評価に追従する。
 * **残ると「妥当と判断した」という誤った印を出し続ける。**
 */
describe('content script の背景の目印', () => {
  it('妥当なら背景を付ける', async () => {
    // Arrange & Act
    document.body.innerHTML = card(1) + card(2);
    await saveVerdict('example-author-1', 'valid');
    await bootContentScript();
    // Assert
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-qtg-judged="true"]')).toHaveLength(1);
    });
  });

  it('誤りに押し直したら背景も消える', async () => {
    // Arrange
    document.body.innerHTML = card(1) + card(2);
    await saveVerdict('example-author-1', 'valid');
    await bootContentScript();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-qtg-judged="true"]')).toHaveLength(1);
    });
    // Act — 誤検知だったので押し直す
    await saveVerdict('example-author-1', 'false_positive');
    storageListener()({ feedback: { newValue: {} } }, 'local');
    // Assert — display を戻すだけでは足りない。色が残ると誤った印になる
    await vi.waitFor(() => {
      expect(visibleCards()).toBe(2);
    });
    expect(document.querySelector('[data-qtg-judged="true"]')).toBeNull();
  });

  it('「表示する」で戻しても背景は残る（どれが該当か分かる）', async () => {
    // Arrange
    document.body.innerHTML = card(1) + card(2);
    await saveVerdict('example-author-1', 'valid');
    await bootContentScript();
    await vi.waitFor(() => {
      expect(visibleCards()).toBe(1);
    });
    // Act
    document.querySelector<HTMLButtonElement>('#qtg-hidden-notice button')?.click();
    // Assert
    expect(visibleCards()).toBe(2);
    expect(document.querySelectorAll('[data-qtg-judged="true"]')).toHaveLength(1);
  });
});

/**
 * ミュートは **メッセージで受ける**。storage.onChanged ではない。
 *
 * 評価が既に valid なら storage の値が変わらず onChanged が発火しないため、
 * そこにぶら下げると押し直しでのやり直しができなくなる。
 * ミュートは状態の同期ではなく操作である。
 */
describe('content script のミュート受信', () => {
  it('MUTE_AUTHOR を受けるとミュートの項目だけを押す', async () => {
    // Arrange
    mountCardWithMenu(1);
    await bootContentScript();
    // Act
    const { sendResponse, returned } = requestMute('example-author-1');
    // Assert — 非同期で応答するので true を返している必要がある
    expect(returned).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });
    expect(sequence).toEqual(['open-1', 'mute-1']);
    expect(sendResponse).toHaveBeenCalledWith({
      type: 'MUTE_RESULT',
      handle: 'example-author-1',
      outcome: 'muted',
    });
  });

  it('トレンド以外のページでは操作せず not-on-page を返す', async () => {
    // Arrange — プロフィールページにも記事一覧と <time> が揃っている
    mountCardWithMenu(1);
    await bootContentScript('/example-author-1');
    // Act
    const { sendResponse, returned } = requestMute('example-author-1');
    // Assert — 同期で応答するのでチャネルは開かない
    expect(returned).toBeUndefined();
    expect(sequence).toEqual([]);
    expect(sendResponse).toHaveBeenCalledWith({
      type: 'MUTE_RESULT',
      handle: 'example-author-1',
      outcome: 'not-on-page',
    });
  });

  it('関係のないメッセージには応答せず、チャネルも開かない', async () => {
    // Arrange
    mountCardWithMenu(1);
    await bootContentScript();
    const sendResponse = vi.fn();
    // Act — service worker 宛ての PING が届くことがある
    const returned = messageListener()({ type: 'PING' }, {}, sendResponse);
    // Assert — true を返すとチャネルが開いたままになり、他のリスナーの応答が捨てられる
    expect(returned).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('handle が無いメッセージには応答しない', async () => {
    mountCardWithMenu(1);
    await bootContentScript();
    const sendResponse = vi.fn();
    const returned = messageListener()({ type: 'MUTE_AUTHOR' }, {}, sendResponse);
    expect(returned).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('2 件続けて依頼しても重ならない', async () => {
    // Arrange — 別々の著者のカードを 2 枚
    mountCardWithMenu(1);
    mountCardWithMenu(2);
    await bootContentScript();
    // Act — 続けざまに 2 件
    const first = requestMute('example-author-1');
    const second = requestMute('example-author-2');

    // Assert 1 — 依頼した時点ではまだ 1 件も走っていない（列に積まれただけ）。
    // muteAuthor を直に呼ぶ実装だと、click まで同期なのでここで既に全部終わっている
    expect(sequence).toEqual([]);

    // Assert 2 — 1 件目が Snackbar を待っているあいだ、2 件目は開始していない。
    // **デバウンスでは同時実行を止められない。**タイマーは発火した瞬間に手を離す
    await vi.waitFor(() => {
      expect(sequence).toContain('mute-1');
    });
    expect(sequence).not.toContain('open-2');

    // Assert 3 — 最後まで走ると 1 件目 → 2 件目の順になる
    await vi.waitFor(
      () => {
        expect(second.sendResponse).toHaveBeenCalled();
      },
      { timeout: 5000 },
    );
    expect(first.sendResponse).toHaveBeenCalled();
    expect(sequence).toEqual(['open-1', 'mute-1', 'open-2', 'mute-2']);
  });

  it('カードが無ければ not-on-page を返し、エラーにしない', async () => {
    // Arrange — トレンドが入れ替わったあと
    mountCardWithMenu(2);
    await bootContentScript();
    // Act
    const { sendResponse } = requestMute('example-author-1');
    // Assert
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        type: 'MUTE_RESULT',
        handle: 'example-author-1',
        outcome: 'not-on-page',
      });
    });
  });
});

/** 「AI文体かも？」の表示。合成のスコアを storage に置いてから起動する */
describe('content script の AI ヒント', () => {
  const ITEM_1 = '0123456789abcdef0001';
  const hint: AiHint = {
    fired: ['dash', 'risingWords'],
    proseChars: 500,
    scoredAt: '2026-10-24T00:00:00.000Z',
  };

  function hintOn(itemId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-qtg-ai-hint="${itemId}"]`);
  }

  function answer(itemId: string, label: 'そうかも' | '違うかも'): void {
    const button = [...(hintOn(itemId)?.querySelectorAll('button') ?? [])].find(
      (element) => element.textContent === label,
    );
    button?.click();
  }

  it('フルモードではスコアのある記事に表示を足す', async () => {
    // Arrange
    document.body.innerHTML = card(1);
    await saveToken('dummy-token-value');
    await saveAiHints({ [ITEM_1]: hint });
    // Act
    await bootContentScript();
    // Assert
    await vi.waitFor(() => {
      expect(hintOn(ITEM_1)?.textContent).toContain('AI文体かも？');
    });
  });

  it('ライトモードではスコアが残っていても表示しない', async () => {
    // Arrange — トークンを外した直後。スコアは 7 日残る
    document.body.innerHTML = card(1);
    await saveAiHints({ [ITEM_1]: hint });
    // Act
    await bootContentScript();
    // Assert
    expect(hintOn(ITEM_1)).toBeNull();
  });

  it('トレンド以外のページでは表示しない', async () => {
    document.body.innerHTML = card(1);
    await saveToken('dummy-token-value');
    await saveAiHints({ [ITEM_1]: hint });
    await bootContentScript('/example-author-1');
    expect(hintOn(ITEM_1)).toBeNull();
  });

  it('そうかも / 違うかもを押すと、回答時の点数と時刻を付けて記事ごとに保存する', async () => {
    // Arrange
    document.body.innerHTML = card(1);
    await saveToken('dummy-token-value');
    await saveAiHints({ [ITEM_1]: hint });
    await bootContentScript();
    await vi.waitFor(() => {
      expect(hintOn(ITEM_1)).not.toBeNull();
    });
    // Act
    answer(ITEM_1, 'そうかも');
    // Assert
    await vi.waitFor(async () => {
      const saved = (await getAiVerdicts())[ITEM_1];
      expect(saved?.verdict).toBe('yes');
      expect(saved?.score).toBe(hint.fired.length);
      // 指標の見直しに使うので、回答時に立っていたシグナルも残す
      expect(saved?.fired).toEqual(hint.fired);
      expect(Number.isNaN(Date.parse(saved?.answeredAt ?? ''))).toBe(false);
    });
  });

  it('回答済みの側をもう一度押すと、回答を消して初期状態に戻す', async () => {
    // Arrange
    document.body.innerHTML = card(1);
    await saveToken('dummy-token-value');
    await saveAiHints({ [ITEM_1]: hint });
    await saveAiVerdict(ITEM_1, {
      verdict: 'yes',
      score: 0,
      fired: [],
      answeredAt: '2026-10-24T00:00:00.000Z',
    });
    await bootContentScript();
    await vi.waitFor(() => {
      expect(hintOn(ITEM_1)).not.toBeNull();
    });
    // Act
    answer(ITEM_1, 'そうかも');
    // Assert — **保存領域の生の値を見る。**getAiVerdicts は壊れた回答を読み飛ばすので、
    // 「答えが null の回答」を書き込む誤りでも空に見えてしまう（コードレビュー M1）
    await vi.waitFor(async () => {
      const raw = await chrome.storage.local.get('aiVerdicts');
      expect(raw.aiVerdicts).toEqual({});
    });
  });

  it('スキャンでスコアが増えたら描き足す', async () => {
    // Arrange
    document.body.innerHTML = card(1);
    await saveToken('dummy-token-value');
    await bootContentScript();
    expect(hintOn(ITEM_1)).toBeNull();
    // Act
    await saveAiHints({ [ITEM_1]: hint });
    storageListener()({ aiHints: { newValue: { [ITEM_1]: hint } } }, 'local');
    // Assert
    await vi.waitFor(() => {
      expect(hintOn(ITEM_1)).not.toBeNull();
    });
  });

  it('回答が変わったら押した側を示し直す', async () => {
    // Arrange
    document.body.innerHTML = card(1);
    await saveToken('dummy-token-value');
    await saveAiHints({ [ITEM_1]: hint });
    await bootContentScript();
    // Act
    const no: AiAnswer = {
      verdict: 'no',
      score: 0,
      fired: [],
      answeredAt: '2026-10-24T00:00:00.000Z',
    };
    await saveAiVerdict(ITEM_1, no);
    storageListener()({ aiVerdicts: { newValue: { [ITEM_1]: no } } }, 'local');
    // Assert
    await vi.waitFor(() => {
      const no = [...(hintOn(ITEM_1)?.querySelectorAll('button') ?? [])].find(
        (element) => element.textContent === '違うかも',
      );
      expect(no?.getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('保存済みの線引きで強調する', async () => {
    // Arrange — 2 点の記事。既定の 5 点なら強調されない
    document.body.innerHTML = card(1);
    await saveToken('dummy-token-value');
    await saveAiHints({ [ITEM_1]: { ...hint, fired: ['dash', 'summaryHeading'] } });
    await saveAiHintPrefs({ threshold: 2, minProseChars: 334, dimLikely: false });
    // Act
    await bootContentScript();
    // Assert
    await vi.waitFor(() => {
      expect(hintOn(ITEM_1)?.dataset.qtgAiLikely).toBe('true');
    });
  });

  it('線引きが変わったら描き直す', async () => {
    // Arrange — 2 点の記事は既定の 5 点では強調されない
    document.body.innerHTML = card(1);
    await saveToken('dummy-token-value');
    await saveAiHints({ [ITEM_1]: { ...hint, fired: ['dash', 'summaryHeading'] } });
    await bootContentScript();
    await vi.waitFor(() => {
      expect(hintOn(ITEM_1)?.dataset.qtgAiLikely).toBe('false');
    });
    // Act — 設定画面で 2 点に下げた
    const aiHintPrefs = { threshold: 2, minProseChars: 334, dimLikely: false };
    await saveAiHintPrefs(aiHintPrefs);
    storageListener()({ aiHintPrefs: { newValue: aiHintPrefs } }, 'local');
    // Assert
    await vi.waitFor(() => {
      expect(hintOn(ITEM_1)?.dataset.qtgAiLikely).toBe('true');
    });
  });

  it('「薄く表示する」をオンにしたら、強調される記事のカードを描き直して薄くする', async () => {
    // Arrange — 2 点の記事を 2 点以上で強調する
    document.body.innerHTML = card(1);
    await saveToken('dummy-token-value');
    await saveAiHints({ [ITEM_1]: { ...hint, fired: ['dash', 'summaryHeading'] } });
    await saveAiHintPrefs({ threshold: 2, minProseChars: 334, dimLikely: false });
    await bootContentScript();
    await vi.waitFor(() => {
      expect(hintOn(ITEM_1)?.dataset.qtgAiLikely).toBe('true');
    });
    expect(hintOn(ITEM_1)?.parentElement?.dataset.qtgAiDim).toBeUndefined();
    // Act — 設定画面でオンにした
    const aiHintPrefs = { threshold: 2, minProseChars: 334, dimLikely: true };
    await saveAiHintPrefs(aiHintPrefs);
    storageListener()({ aiHintPrefs: { newValue: aiHintPrefs } }, 'local');
    // Assert
    await vi.waitFor(() => {
      expect(hintOn(ITEM_1)?.parentElement?.dataset.qtgAiDim).toBe('true');
    });
  });
});

/**
 * Qiita のページはスクリプトの後からカードを作り直すことがある。2026-10-24 の実機で、
 * スコアが保存済みのときだけ「一瞬出て消える」が起きた（表示の要素が 0 件になった）。
 */
describe('content script の AI ヒントの描き直し', () => {
  const ITEM_1 = '0123456789abcdef0001';
  const hint = { fired: [], proseChars: 500, scoredAt: '2026-10-24T00:00:00.000Z' };

  it('カードが作り直されて表示が消えたら、描き直す', async () => {
    // Arrange
    document.body.innerHTML = card(1);
    await saveToken('dummy-token-value');
    await saveAiHints({ [ITEM_1]: hint });
    await bootContentScript();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-qtg-ai-hint]')).not.toBeNull();
    });
    // Act — React がカードを丸ごと作り直した状況
    document.body.innerHTML = card(1);
    // Assert
    await vi.waitFor(() => {
      expect(document.querySelector(`[data-qtg-ai-hint="${ITEM_1}"]`)).not.toBeNull();
    });
  });

  it('自分の描画には反応しない（描き直しが止まらなくならない）', async () => {
    // Arrange
    document.body.innerHTML = card(1);
    await saveToken('dummy-token-value');
    await saveAiHints({ [ITEM_1]: hint });
    const getSpy = vi.spyOn(chrome.storage.local, 'get');
    await bootContentScript();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-qtg-ai-hint]')).not.toBeNull();
    });
    // Act — 監視の待ち時間より長く待つ
    await new Promise((resolve) => setTimeout(resolve, 600));
    const settled = getSpy.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Assert — 落ち着いたあとは storage を読みに行かない
    expect(getSpy.mock.calls.length).toBe(settled);
  });
});

/** コードレビュー M2: 描き直しの監視が止まらない・始まりすぎないこと */
describe('content script の AI ヒントの監視', () => {
  const ITEM_1 = '0123456789abcdef0001';
  const hint = { fired: [], proseChars: 500, scoredAt: '2026-10-24T00:00:00.000Z' };

  it('ページが変化し続けても、最長 1 秒ほどで描き直す', async () => {
    // Arrange
    document.body.innerHTML = card(1) + '<div id="ticker"></div>';
    await saveToken('dummy-token-value');
    await saveAiHints({ [ITEM_1]: hint });
    await bootContentScript();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-qtg-ai-hint]')).not.toBeNull();
    });
    // 広告や時刻表示のように、待ち時間より短い間隔で変化し続ける
    const ticker = setInterval(() => {
      document
        .getElementById('ticker')
        ?.replaceChildren(document.createTextNode(String(Date.now())));
    }, 100);
    try {
      // Act — カードが作り直される
      document.body.innerHTML = card(1) + '<div id="ticker"></div>';
      // Assert
      await vi.waitFor(
        () => {
          expect(document.querySelector(`[data-qtg-ai-hint="${ITEM_1}"]`)).not.toBeNull();
        },
        { timeout: 2000 },
      );
    } finally {
      clearInterval(ticker);
    }
  });

  it('ライトモードではページの監視を始めない', async () => {
    // Arrange — 前のテストの content script の監視は残っているので、
    // 「今回の起動で observe を呼んだか」だけを数える
    document.body.innerHTML = card(1);
    await saveAiHints({ [ITEM_1]: hint });
    const observeSpy = vi.spyOn(MutationObserver.prototype, 'observe');
    // Act
    await bootContentScript();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Assert
    expect(observeSpy).not.toHaveBeenCalled();
    observeSpy.mockRestore();
  });

  it('フルモードで描いたら監視を始める（1 回だけ）', async () => {
    document.body.innerHTML = card(1);
    await saveToken('dummy-token-value');
    await saveAiHints({ [ITEM_1]: hint });
    const observeSpy = vi.spyOn(MutationObserver.prototype, 'observe');
    await bootContentScript();
    await vi.waitFor(() => {
      expect(observeSpy).toHaveBeenCalledTimes(1);
    });
    // 描き直しが走っても 2 本目は作らない
    const yes: AiAnswer = {
      verdict: 'yes',
      score: 0,
      fired: [],
      answeredAt: '2026-10-24T00:00:00.000Z',
    };
    await saveAiVerdict(ITEM_1, yes);
    storageListener()({ aiVerdicts: { newValue: { [ITEM_1]: yes } } }, 'local');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(observeSpy).toHaveBeenCalledTimes(1);
    observeSpy.mockRestore();
  });
});
