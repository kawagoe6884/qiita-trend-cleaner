import { describe, it, expect, vi, beforeEach } from 'vitest';
import { init, describeToggleState } from './options-page';
import { loadState, submitToken, removeToken } from './token-form';
import { logger } from '../../lib/logger';
// 実際に配布される HTML をそのまま読む（Vite の ?raw）。
// setupDom() は骨格のモックなので、**順序は実ファイルに対して検査する**
import indexHtml from './index.html?raw';
import type * as TokenForm from './token-form';

vi.mock('./token-form', async (importOriginal) => {
  const actual = await importOriginal<typeof TokenForm>();
  return {
    ...actual,
    loadState: vi.fn(),
    submitToken: vi.fn(),
    removeToken: vi.fn(),
  };
});

const loadMock = vi.mocked(loadState);
const submitMock = vi.mocked(submitToken);
const removeMock = vi.mocked(removeToken);

/** index.html と同じ骨格。id と hidden の扱いを実物に合わせる */
function setupDom(): void {
  document.body.innerHTML = `
    <section class="mode">
      <p class="mode-title" id="mode-title"></p>
      <p class="mode-detail" id="mode-detail"></p>
    </section>
    <section id="saved" class="saved" hidden>
      <span class="saved-label">設定済みのトークン</span>
      <code id="masked"></code>
      <button type="button" id="remove">削除する</button>
    </section>
    <form id="token-form">
      <input type="password" id="token" autocomplete="off" />
      <button type="submit" id="save">保存する</button>
    </form>
    <p id="message" role="status" aria-live="polite"></p>
    <section class="prefs">
      <label class="toggle">
        <input type="checkbox" id="mute-on-valid" />
        <span class="track"></span>
        <span>「妥当」と同時に Qiita 側でもミュート</span>
        <strong class="toggle-state" id="mute-on-valid-state"></strong>
      </label>
      <div class="fold-grid">
        <label class="fold-option">
          <input type="radio" name="fold-target" value="none" />そのまま一覧に出す
        </label>
        <label class="fold-option">
          <input type="radio" name="fold-target" value="muted" />ミュート済みだけ
        </label>
        <label class="fold-option">
          <input type="radio" name="fold-target" value="valid" />「妥当」だけ
        </label>
        <label class="fold-option">
          <input type="radio" name="fold-target" value="judged" />評価済みをすべて
        </label>
      </div>
    </section>`;
}

function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

/** submit を発火し、preventDefault されたか（＝リスナーが付いているか）を返す */
function dispatchSubmit(): boolean {
  const event = new Event('submit', { cancelable: true, bubbles: true });
  el('#token-form').dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDom();
  loadMock.mockResolvedValue({ kind: 'light' });
  submitMock.mockResolvedValue({ kind: 'full', masked: 'dumm••••••••cdef' });
  removeMock.mockResolvedValue({ kind: 'light' });
});

describe('init — 正常系', () => {
  it('保存状態を画面に反映する', async () => {
    // Arrange
    loadMock.mockResolvedValue({ kind: 'full', masked: 'dumm••••••••cdef' });
    // Act
    await init();
    // Assert
    expect(el('#mode-title').textContent).toContain('フルモード');
    expect(el('#saved').hidden).toBe(false);
    expect(el('#masked').textContent).toBe('dumm••••••••cdef');
  });

  it('未設定ならライトモードを表示し保存済みパネルを隠す', async () => {
    await init();
    expect(el('#mode-title').textContent).toContain('ライトモード');
    expect(el('#saved').hidden).toBe(true);
  });

  it('submit は preventDefault される（ネイティブ送信させない）', async () => {
    await init();
    expect(dispatchSubmit()).toBe(true);
  });
});

describe('init — storage が失敗しても操作を殺さない', () => {
  it('loadState が失敗してもリスナーは付く', async () => {
    // Arrange — ここが本題。リスナー登録が await より後ろにあると
    // ネイティブ GET 送信になり、入力値が URL に載る
    loadMock.mockRejectedValue(new Error('Extension context invalidated'));
    // Act
    await init();
    // Assert
    expect(dispatchSubmit()).toBe(true);
  });

  it('loadState が失敗したら画面にメッセージを出す', async () => {
    loadMock.mockRejectedValue(new Error('storage down'));
    await init();
    expect(el('#message').textContent).toBeTruthy();
  });

  it('loadState が失敗したらモード表示を空にする（嘘の状態を出さない）', async () => {
    loadMock.mockRejectedValue(new Error('storage down'));
    await init();
    expect(el('#mode-title').textContent).toBe('');
    expect(el('#mode-detail').textContent).toBe('');
    expect(el('#saved').hidden).toBe(true);
  });

  it('init 自体は reject しない', async () => {
    loadMock.mockRejectedValue(new Error('storage down'));
    await expect(init()).resolves.toBeUndefined();
  });
});

describe('submit の失敗が画面を固まらせない', () => {
  it('submitToken が reject しても「確認中」のまま残らない', async () => {
    // Arrange — 保存済みの状態で保存が失敗する（storage の書き込み失敗など）
    loadMock.mockResolvedValue({ kind: 'full', masked: 'dumm••••••••cdef' });
    submitMock.mockRejectedValue(new Error('Extension context invalidated'));
    await init();
    // Act
    el<HTMLInputElement>('#token').value = 'dummy-token-value-0123456789abcdef';
    dispatchSubmit();
    await vi.waitFor(() => {
      expect(el('#mode-title').textContent).not.toContain('確認中');
    });
    // Assert — 実際の保存状態（フルモード）へ戻る
    expect(el('#mode-title').textContent).toContain('フルモード');
    expect(el('#saved').hidden).toBe(false);
    expect(el('#message').textContent).toBeTruthy();
  });

  it('保存も再読み込みも失敗したらモード表示を空にする', async () => {
    // Arrange — storage 自体が死んでいて実際の状態が分からない
    submitMock.mockRejectedValue(new Error('write failed'));
    await init();
    loadMock.mockRejectedValue(new Error('read failed'));
    // Act
    el<HTMLInputElement>('#token').value = 'dummy-token-value-0123456789abcdef';
    dispatchSubmit();
    await vi.waitFor(() => {
      expect(el('#message').textContent).toBeTruthy();
    });
    // Assert — 分からない状態を断定しない
    expect(el('#mode-title').textContent).toBe('');
  });

  it('送信中はボタンを無効にし、終わったら戻す', async () => {
    // Arrange
    await init();
    let resolveSubmit: (value: { kind: 'light' }) => void = () => undefined;
    submitMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve;
      }),
    );
    // Act
    el<HTMLInputElement>('#token').value = 'dummy-token-value-0123456789abcdef';
    dispatchSubmit();
    await vi.waitFor(() => {
      expect(el<HTMLButtonElement>('#save').disabled).toBe(true);
    });
    resolveSubmit({ kind: 'light' });
    // Assert
    await vi.waitFor(() => {
      expect(el<HTMLButtonElement>('#save').disabled).toBe(false);
    });
  });
});

describe('削除', () => {
  it('削除するとライトモードに戻り保存済みパネルが隠れる', async () => {
    // Arrange
    loadMock.mockResolvedValue({ kind: 'full', masked: 'dumm••••••••cdef' });
    await init();
    expect(el('#saved').hidden).toBe(false);
    // Act
    el<HTMLButtonElement>('#remove').click();
    // Assert
    await vi.waitFor(() => {
      expect(el('#saved').hidden).toBe(true);
    });
    expect(el('#mode-title').textContent).toContain('ライトモード');
  });

  it('削除が失敗しても画面が固まらない', async () => {
    loadMock.mockResolvedValue({ kind: 'full', masked: 'dumm••••••••cdef' });
    await init();
    removeMock.mockRejectedValue(new Error('remove failed'));
    el<HTMLButtonElement>('#remove').click();
    await vi.waitFor(() => {
      expect(el('#message').textContent).toBeTruthy();
    });
    // 実際の保存状態（フルモード）が維持される
    expect(el('#saved').hidden).toBe(false);
  });
});

describe('入力欄の扱い（失敗時に消さない）', () => {
  const TYPED = 'newly-typed-token-0123456789abcdef';

  it('保存に成功したら入力欄を空にする', async () => {
    // Arrange
    await init();
    submitMock.mockResolvedValue({ kind: 'full', masked: 'newl••••••••cdef' });
    // Act
    el<HTMLInputElement>('#token').value = TYPED;
    dispatchSubmit();
    // Assert
    await vi.waitFor(() => {
      expect(el<HTMLInputElement>('#token').value).toBe('');
    });
  });

  it('検証に失敗したら入力欄を残す（直せるように）', async () => {
    // Arrange — submitToken は resolve するが message を載せて返す
    await init();
    submitMock.mockResolvedValue({
      kind: 'light',
      message: 'トークンが受け付けられませんでした。',
    });
    // Act
    el<HTMLInputElement>('#token').value = TYPED;
    dispatchSubmit();
    await vi.waitFor(() => {
      expect(el('#message').textContent).toBeTruthy();
    });
    // Assert
    expect(el<HTMLInputElement>('#token').value).toBe(TYPED);
  });

  it('保存済みトークンがある状態で submitToken が reject しても入力欄を残す', async () => {
    // Arrange — restoreMode が loadState() の {kind:'full'} を render するため、
    // render が「保存成功」と誤認して入力を消していた経路
    loadMock.mockResolvedValue({ kind: 'full', masked: 'dumm••••••••cdef' });
    await init();
    submitMock.mockRejectedValue(new Error('Extension context invalidated'));
    // Act
    el<HTMLInputElement>('#token').value = TYPED;
    dispatchSubmit();
    await vi.waitFor(() => {
      expect(el('#message').textContent).toBeTruthy();
    });
    // Assert — エラーを出したうえで入力は保持する
    expect(el<HTMLInputElement>('#token').value).toBe(TYPED);
  });

  it('保存済みトークンがある状態で removeToken が reject しても入力欄を残す', async () => {
    // Arrange
    loadMock.mockResolvedValue({ kind: 'full', masked: 'dumm••••••••cdef' });
    await init();
    removeMock.mockRejectedValue(new Error('remove failed'));
    // Act
    el<HTMLInputElement>('#token').value = TYPED;
    el<HTMLButtonElement>('#remove').click();
    await vi.waitFor(() => {
      expect(el('#message').textContent).toBeTruthy();
    });
    // Assert
    expect(el<HTMLInputElement>('#token').value).toBe(TYPED);
  });

  it('初期表示では入力欄に触れない', async () => {
    // Arrange
    loadMock.mockResolvedValue({ kind: 'full', masked: 'dumm••••••••cdef' });
    el<HTMLInputElement>('#token').value = TYPED;
    // Act
    await init();
    // Assert
    expect(el<HTMLInputElement>('#token').value).toBe(TYPED);
  });
});

describe('操作中のロック（古い応答が新しい入力を消さない）', () => {
  /** submitToken を保留にして「検証中」を再現する */
  function pendingSubmit(): (value: { kind: 'full'; masked: string }) => void {
    let release: (value: { kind: 'full'; masked: string }) => void = () => undefined;
    submitMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }

  it('検証中は入力欄を readOnly にして編集を止める', async () => {
    // Arrange
    await init();
    const release = pendingSubmit();
    // Act
    el<HTMLInputElement>('#token').value = 'first-token-0123456789abcdef';
    dispatchSubmit();
    // Assert — ここで打ち直せると、古い応答の clearInput が新しい入力を消す
    await vi.waitFor(() => {
      expect(el<HTMLInputElement>('#token').readOnly).toBe(true);
    });
    release({ kind: 'full', masked: 'firs••••••••cdef' });
    await vi.waitFor(() => {
      expect(el<HTMLInputElement>('#token').readOnly).toBe(false);
    });
  });

  it('検証中は削除ボタンも押せない', async () => {
    // Arrange
    loadMock.mockResolvedValue({ kind: 'full', masked: 'dumm••••••••cdef' });
    await init();
    const release = pendingSubmit();
    // Act
    el<HTMLInputElement>('#token').value = 'first-token-0123456789abcdef';
    dispatchSubmit();
    await vi.waitFor(() => {
      expect(el<HTMLButtonElement>('#remove').disabled).toBe(true);
    });
    // Assert — クリックしても removeToken は呼ばれない
    el<HTMLButtonElement>('#remove').click();
    expect(removeMock).not.toHaveBeenCalled();
    release({ kind: 'full', masked: 'firs••••••••cdef' });
  });

  it('検証中に再送信しても二重に呼ばれない', async () => {
    // Arrange
    await init();
    const release = pendingSubmit();
    el<HTMLInputElement>('#token').value = 'first-token-0123456789abcdef';
    // Act
    dispatchSubmit();
    dispatchSubmit();
    dispatchSubmit();
    // Assert
    expect(submitMock).toHaveBeenCalledTimes(1);
    release({ kind: 'full', masked: 'firs••••••••cdef' });
  });

  it('失敗して復帰したあともロックが解ける', async () => {
    // Arrange
    await init();
    submitMock.mockRejectedValue(new Error('boom'));
    // Act
    el<HTMLInputElement>('#token').value = 'first-token-0123456789abcdef';
    dispatchSubmit();
    // Assert
    await vi.waitFor(() => {
      expect(el('#message').textContent).toBeTruthy();
    });
    expect(el<HTMLInputElement>('#token').readOnly).toBe(false);
    expect(el<HTMLButtonElement>('#save').disabled).toBe(false);
    expect(el<HTMLButtonElement>('#remove').disabled).toBe(false);
  });
});

/**
 * 候補の見え方（Phase 9 でポップアップから移した 2 つ）。
 *
 * どちらも `storage.local`。判定の閾値（sync）とは置き場が違う。
 * **この画面は検出をやり直さない** — 保存するだけで、次にポップアップを
 * 開いたときに反映される。
 */
describe('候補の見え方の設定', () => {
  function radios(): HTMLInputElement[] {
    return [...document.querySelectorAll<HTMLInputElement>('input[name="fold-target"]')];
  }

  function pick(value: string): void {
    const radio = radios().find((input) => input.value === value);
    if (!radio) throw new Error(`missing radio: ${value}`);
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
  }

  it('未設定ならトグルはオフ、折りたたみは「なし」', async () => {
    // Act
    await init();
    // Assert — 既定は「Qiita 側を変えない」「視界から消さない」
    expect(el<HTMLInputElement>('#mute-on-valid').checked).toBe(false);
    expect(radios().find((input) => input.checked)?.value).toBe('none');
  });

  it('保存済みの値を映す', async () => {
    // Arrange
    await chrome.storage.local.set({ muteOnValid: true, foldTarget: 'judged' });
    // Act
    await init();
    // Assert
    expect(el<HTMLInputElement>('#mute-on-valid').checked).toBe(true);
    expect(radios().find((input) => input.checked)?.value).toBe('judged');
  });

  it('トグルを入れると保存する', async () => {
    // Arrange
    await init();
    const toggle = el<HTMLInputElement>('#mute-on-valid');
    // Act
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    // Assert
    await vi.waitFor(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ muteOnValid: true });
    });
  });

  it('トグルを外すと false を保存する（キーごと消さない）', async () => {
    await chrome.storage.local.set({ muteOnValid: true });
    await init();
    const toggle = el<HTMLInputElement>('#mute-on-valid');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ muteOnValid: false });
    });
  });

  it('折りたたみを選ぶと保存する', async () => {
    await init();
    pick('muted');
    await vi.waitFor(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ foldTarget: 'muted' });
    });
  });

  it('4 択すべてが保存できる', async () => {
    await init();
    for (const value of ['none', 'muted', 'valid', 'judged']) {
      pick(value);
      await vi.waitFor(() => {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(chrome.storage.local.set).toHaveBeenCalledWith({ foldTarget: value });
      });
    }
  });

  it('知らない値は保存しない（HTML を書き換えられても storage に入らない）', async () => {
    // Arrange
    await init();
    const radio = radios()[0];
    if (!radio) throw new Error('missing radio');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(chrome.storage.local.set).mockClear();
    // Act
    radio.value = 'everything';
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    // Assert
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('開いた時点で「する」「しない」が出ている', async () => {
    // Arrange — 色とつまみの位置だけでは状態が読み取りにくい
    await chrome.storage.local.set({ muteOnValid: true });
    // Act
    await init();
    // Assert
    expect(el('#mute-on-valid-state').textContent).toBe('する');
  });

  it('オフなら「しない」', async () => {
    await init();
    expect(el('#mute-on-valid-state').textContent).toBe('しない');
  });

  it('切り替えると文言もその場で変わる（保存の往復を待たない）', async () => {
    // Arrange
    await init();
    const toggle = el<HTMLInputElement>('#mute-on-valid');
    // Act
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    // Assert — storage の往復を待つと、押した瞬間の文言が古いまま残る
    expect(el('#mute-on-valid-state').textContent).toBe('する');
    // Act — 戻す
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    // Assert
    expect(el('#mute-on-valid-state').textContent).toBe('しない');
  });

  it('見え方の読み込みが失敗しても init は落ちない', async () => {
    // Arrange — storage が死んでいる状態。トークン側とは別の try で受ける。
    // 差し替えて戻すだけで呼び出さないので、unbound-method の懸念は当たらない
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const get = chrome.storage.local.get;
    (chrome.storage.local as { get: unknown }).get = () =>
      Promise.reject(new Error('storage down'));
    try {
      // Act & Assert — ここで throw すると options ページ全体が白紙になる
      await expect(init()).resolves.toBeUndefined();
    } finally {
      (chrome.storage.local as { get: unknown }).get = get;
    }
  });

  it('トークンの読み込みが失敗しても見え方の設定は出す', async () => {
    // Arrange — storage キーが別なので、片方の失敗で両方を落とさない
    await chrome.storage.local.set({ foldTarget: 'valid' });
    loadMock.mockRejectedValue(new Error('storage unavailable'));
    // Act
    await init();
    // Assert
    expect(radios().find((input) => input.checked)?.value).toBe('valid');
  });
});

/**
 * **色だけで状態を伝えない。**色覚や表示環境（強制カラー・モノクロ印刷）では
 * 色の差が届かず、つまみの移動も 20px でしかない。
 */
describe('見え方の設定 — 保存に失敗したときのログ水準', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
  });

  /** 次の 1 回だけ storage の書き込みを失敗させる */
  function failNextWrite(): void {
    // set はモックの vi.fn そのもので this を使わない（src/test/setup.ts）
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(
      new Error('Extension context invalidated'),
    );
  }

  it('トグルの保存が失敗しても error / warn には載せない', async () => {
    // Arrange — 拡張がリロードされた瞬間に options タブが残っていると起きる。
    // **ユーザーの操作が失敗しただけで、拡張が壊れているわけではない**
    await init();
    failNextWrite();
    const toggle = el<HTMLInputElement>('#mute-on-valid');
    // Act
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    // Assert — Chrome は warn も chrome://extensions のエラー欄に集める
    await vi.waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith('failed to save mute setting:', expect.any(Error));
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('折りたたみの保存が失敗しても error / warn には載せない', async () => {
    // Arrange — 経路が 2 本あるので 2 本とも検査する。
    // **ログ水準の修正は経路ごとに漏れる**（Phase 4b の 401 と同じ形）
    await init();
    failNextWrite();
    const radio = el<HTMLInputElement>('input[name="fold-target"][value="judged"]');
    // Act
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    // Assert
    await vi.waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith('failed to save fold setting:', expect.any(Error));
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('describeToggleState', () => {
  it('オンは「する」', () => {
    expect(describeToggleState(true)).toBe('する');
  });

  it('オフは「しない」', () => {
    expect(describeToggleState(false)).toBe('しない');
  });

  it('2 つは別の文言（同じだと状態が読めない）', () => {
    expect(describeToggleState(true)).not.toBe(describeToggleState(false));
  });
});

/**
 * **実ファイルに対して順序を固定する。**
 *
 * Phase 9 で「候補の見え方」を足したとき、トークンの入力欄と取得手順のあいだに
 * 割り込ませてしまい、**手順を見ながら入力できない配置**になった。
 * 骨格のモックでは検出できないので、`index.html?raw` に対して検査する。
 */
describe('index.html のレイアウト順序', () => {
  it('トークンの取得手順が入力欄の直後にある（あいだに何も挟まない）', () => {
    const form = indexHtml.indexOf('id="token-form"');
    const howTo = indexHtml.indexOf('トークンの取得手順');
    const prefs = indexHtml.indexOf('class="prefs"');
    expect(form).toBeGreaterThan(-1);
    expect(howTo).toBeGreaterThan(form);
    expect(howTo).toBeLessThan(prefs);
  });

  it('候補の見え方はページの最後にある', () => {
    // トークンは「まず設定するもの」、見え方は「あとから調整するもの」
    const prefs = indexHtml.indexOf('class="prefs"');
    const mode = indexHtml.indexOf('id="mode-title"');
    expect(prefs).toBeGreaterThan(mode);
  });

  it('トグルは <input type="checkbox"> のまま（見た目だけ差し替える）', () => {
    // div で自作すると、キーボード操作と支援技術の扱いを全部自前で書くことになる
    expect(indexHtml).toContain('<input type="checkbox" id="mute-on-valid" />');
  });

  it('状態の文言を置く場所がある（色だけで伝えない）', () => {
    expect(indexHtml).toContain('id="mute-on-valid-state"');
  });

  it('オンの色は琥珀系（赤でも緑でもない）', () => {
    // Arrange — 赤 = 断定（約束 6）。緑 = 「良い」と読める。ここでオンにするのは
    // Qiita 側のアカウントを変更する副作用の有効化なので、どちらも違う。
    // hider.ts が「妥当」のカードに使っている琥珀と同じ色相に揃える
    const rule = indexHtml.slice(
      indexHtml.indexOf('.toggle input:checked + .track {'),
      indexHtml.indexOf('.toggle-state {'),
    );
    // Act — rgba(r, g, b, a) を取り出す
    const channels = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(rule);
    expect(channels).not.toBeNull();
    const [r, g, b] = (channels ?? []).slice(1).map(Number);
    // Assert — r > g > b は琥珀・橙だけが満たす。
    // 純赤 (255,0,0) は g > b を満たさず、緑 (0,255,0) は r > g を満たさない
    expect(r).toBeGreaterThan(g ?? 0);
    expect(g).toBeGreaterThan(b ?? 0);
  });

  it('実スクショを埋め込まない（実アカウント名が配布物に入る）', () => {
    expect(indexHtml).not.toContain('data:image/png');
    expect(indexHtml).not.toContain('.png');
    expect(indexHtml).not.toContain('.jpg');
  });
});
