import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveVerdict } from '../lib/storage';
import { SELECTORS, MENU_TEXT, SNACKBAR_TEXT } from '../dom/selectors';

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

/**
 * 三点メニュー付きのカード。実測どおり「フォロー / **ブロック** / ミュート」の順。
 * ブロックがミュートの直上にあることを、ここでも再現しておく。
 */
function cardWithMenu(n: number, author = `example-author-${String(n)}`): string {
  const itemId = `0123456789abcdef${String(n).padStart(4, '0')}`;
  const url = `https://qiita.com/${author}/items/${itemId}`;
  const items = ['投稿ユーザーをフォロー', MENU_TEXT.block, MENU_TEXT.mute]
    .map((text) => `<li role="menuitem" data-label="${text}">${text}</li>`)
    .join('');
  return [
    `<div class="card" data-n="${String(n)}">`,
    `<a href="${url}"></a>`,
    '<time datetime="2026-08-18T10:00:00Z">2026年08月18日</time>',
    `<a href="${url}">タイトル ${String(n)}</a>`,
    `<button aria-haspopup="dialog" aria-label="ユーザーを管理" aria-controls=":r${String(n)}:"></button>`,
    `<ul role="menu" id=":r${String(n)}:">${items}</ul>`,
    '</div>',
  ].join('');
}

/** 押した順序を記録する。**直列化の検査に使う**（時間そのものは検査しない） */
function trackSequence(): string[] {
  const sequence: string[] = [];
  for (const card of document.querySelectorAll<HTMLElement>('.card')) {
    const n = card.dataset.n ?? '?';
    card.querySelector(SELECTORS.cardMenuButton)?.addEventListener('click', () => {
      sequence.push(`open-${n}`);
    });
    for (const item of card.querySelectorAll<HTMLElement>(SELECTORS.menuItem)) {
      item.addEventListener('click', () => {
        sequence.push(`${item.dataset.label === MENU_TEXT.mute ? 'mute' : 'OTHER'}-${n}`);
        // Qiita は完了を Snackbar で知らせる。**遅らせるのが要点** —
        // 同期で出すと waitForSnackbar が即座に解決し、直列化していない実装でも
        // 同じ順序になってしまう（muteAuthor は click まで全部同期）
        setTimeout(() => {
          document.body.insertAdjacentHTML(
            'beforeend',
            `<div id="Snackbar-react-component-abc"><div aria-live="polite" aria-atomic="true"><p>${SNACKBAR_TEXT.muteCompleted}</p></div></div>`,
          );
        }, 0);
      });
    }
  }
  return sequence;
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
  document.body.innerHTML = '';
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
    document.body.innerHTML = cardWithMenu(1);
    await bootContentScript();
    const sequence = trackSequence();
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
    document.body.innerHTML = cardWithMenu(1);
    await bootContentScript('/example-author-1');
    const sequence = trackSequence();
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
    document.body.innerHTML = cardWithMenu(1);
    await bootContentScript();
    const sendResponse = vi.fn();
    // Act — service worker 宛ての PING が届くことがある
    const returned = messageListener()({ type: 'PING' }, {}, sendResponse);
    // Assert — true を返すとチャネルが開いたままになり、他のリスナーの応答が捨てられる
    expect(returned).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('handle が無いメッセージには応答しない', async () => {
    document.body.innerHTML = cardWithMenu(1);
    await bootContentScript();
    const sendResponse = vi.fn();
    const returned = messageListener()({ type: 'MUTE_AUTHOR' }, {}, sendResponse);
    expect(returned).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('2 件続けて依頼しても重ならない', async () => {
    // Arrange — 別々の著者のカードを 2 枚
    document.body.innerHTML = cardWithMenu(1) + cardWithMenu(2);
    await bootContentScript();
    const sequence = trackSequence();
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
    document.body.innerHTML = cardWithMenu(2);
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
