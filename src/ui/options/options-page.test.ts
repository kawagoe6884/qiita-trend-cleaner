import { describe, it, expect, vi, beforeEach } from 'vitest';
import { init } from './options-page';
import { loadState, submitToken, removeToken } from './token-form';
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
    <p id="message" role="status" aria-live="polite"></p>`;
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
