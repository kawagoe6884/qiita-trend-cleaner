import { describe, it, expect, vi, beforeEach } from 'vitest';
import { maskToken, describeMode, loadState, submitToken, removeToken } from './token-form';
import { verifyToken } from '../../api/qiita-client';
import { getToken, saveToken } from '../../lib/storage';

vi.mock('../../api/qiita-client', () => ({ verifyToken: vi.fn() }));
const verifyMock = vi.mocked(verifyToken);

/** 合成トークン。実トークンは使わない */
const VALID = 'dummy-token-value-0123456789abcdef';
const OTHER = 'another-dummy-token-fedcba9876543210';

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockResolvedValue({ ok: true });
});

describe('maskToken', () => {
  it('長いトークンは前後 4 文字だけ残す', () => {
    // Act
    const masked = maskToken(VALID);
    // Assert
    expect(masked.startsWith('dumm')).toBe(true);
    expect(masked.endsWith('cdef')).toBe(true);
  });

  it('元の値が結果に含まれない', () => {
    expect(maskToken(VALID)).not.toContain(VALID);
    expect(maskToken(VALID)).not.toContain('token-value');
  });

  it('短いトークンは全マスクする', () => {
    // Arrange — 12 文字以下は中身を 1 文字も出さない
    const masked = maskToken('short-token');
    // Assert
    expect(masked).toBe('•'.repeat('short-token'.length));
    expect(masked).not.toMatch(/[a-z]/);
  });

  it('長さを推測させないよう中央のマスク幅は固定', () => {
    const a = maskToken('a'.repeat(20));
    const b = maskToken('b'.repeat(40));
    expect(a.length).toBe(b.length);
  });
});

describe('describeMode', () => {
  it('ライトモードの文言に認証なしの上限が入る', () => {
    const copy = describeMode({ kind: 'light' });
    expect(copy.title).toContain('ライトモード');
    expect(copy.detail).toContain('60');
  });

  it('フルモードの文言に認証ありの上限が入る', () => {
    const copy = describeMode({ kind: 'full', masked: '••••' });
    expect(copy.title).toContain('フルモード');
    expect(copy.detail).toContain('1000');
  });

  it('メッセージが付いていてもモードの文言は保存状態に従う', () => {
    // Arrange — 失敗メッセージが付いた full 状態
    const copy = describeMode({ kind: 'full', masked: '••••', message: '失敗しました' });
    // Assert — メッセージの有無でモード表示を変えない
    expect(copy.title).toContain('フルモード');
  });
});

describe('loadState', () => {
  it('未設定ならライトモード', async () => {
    await expect(loadState()).resolves.toEqual({ kind: 'light' });
  });

  it('設定済みならフルモードでマスク済みの値を返す', async () => {
    // Arrange
    await saveToken(VALID);
    // Act
    const state = await loadState();
    // Assert — 生の値を画面へ戻さない
    expect(state.kind).toBe('full');
    if (state.kind !== 'full') return;
    expect(state.masked).not.toBe(VALID);
    expect(state.masked).toContain('•');
  });
});

describe('submitToken — 未設定から', () => {
  it('空文字は検証せずメッセージだけ返す', async () => {
    // Act
    const state = await submitToken('');
    // Assert
    expect(state.kind).toBe('light');
    expect(state.message).toBeTruthy();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('空白のみも検証しない', async () => {
    const state = await submitToken('   \n ');
    expect(state.kind).toBe('light');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('前後の空白を落として検証する', async () => {
    // Arrange — コピペで混ざる空白を吸収する
    await submitToken(`  ${VALID}\n`);
    // Assert
    expect(verifyMock).toHaveBeenCalledWith(VALID);
  });

  it('検証に成功したら保存してフルモードになる', async () => {
    // Act
    const state = await submitToken(VALID);
    // Assert
    expect(state.kind).toBe('full');
    expect(state.message).toBeUndefined();
    await expect(getToken()).resolves.toBe(VALID);
  });

  it('401 のときは保存せずライトモードのまま', async () => {
    // Arrange
    verifyMock.mockResolvedValue({ ok: false, reason: 'invalid' });
    // Act
    const state = await submitToken(VALID);
    // Assert — 無効なトークンを storage に残さない
    expect(state.kind).toBe('light');
    expect(state.message).toBeTruthy();
    await expect(getToken()).resolves.toBeNull();
  });

  it('通信失敗のときも保存しない', async () => {
    verifyMock.mockResolvedValue({ ok: false, reason: 'network' });
    const state = await submitToken(VALID);
    expect(state.kind).toBe('light');
    await expect(getToken()).resolves.toBeNull();
  });

  it('無効と通信失敗で文言が異なる', async () => {
    // Arrange
    verifyMock.mockResolvedValue({ ok: false, reason: 'invalid' });
    const invalid = await submitToken(VALID);
    verifyMock.mockResolvedValue({ ok: false, reason: 'network' });
    const network = await submitToken(VALID);
    // Assert — 通信断を「トークンが無効」と言わない
    expect(invalid.message).not.toBe(network.message);
  });

  it('メッセージにトークンを含めない', async () => {
    verifyMock.mockResolvedValue({ ok: false, reason: 'invalid' });
    const state = await submitToken(VALID);
    expect(state.message).not.toContain(VALID);
  });
});

describe('submitToken — 保存済みトークンがある状態から', () => {
  beforeEach(async () => {
    await saveToken(VALID);
  });

  it('差し替えに失敗してもフルモードのまま（UI が嘘をつかない）', async () => {
    // Arrange — 既に有効なトークンがあり、別のトークンへの差し替えが 401 になる
    verifyMock.mockResolvedValue({ ok: false, reason: 'invalid' });
    // Act
    const state = await submitToken(OTHER);
    // Assert — storage には古いトークンが残っており scanner はフルモードで動き続ける。
    // ここで light を返すと画面だけが「ライトモード」と嘘をつく
    expect(state.kind).toBe('full');
    expect(state.message).toBeTruthy();
    await expect(getToken()).resolves.toBe(VALID);
  });

  it('通信失敗でもフルモードのまま', async () => {
    verifyMock.mockResolvedValue({ ok: false, reason: 'network' });
    const state = await submitToken(OTHER);
    expect(state.kind).toBe('full');
    await expect(getToken()).resolves.toBe(VALID);
  });

  it('空フォームを送信してもフルモードのまま', async () => {
    // Arrange — 削除ボタンが消える経路がここにもあった
    const state = await submitToken('');
    // Assert
    expect(state.kind).toBe('full');
    expect(state.message).toBeTruthy();
    await expect(getToken()).resolves.toBe(VALID);
  });

  it('失敗時もマスク済みの値を返す（削除ボタンを出せる）', async () => {
    verifyMock.mockResolvedValue({ ok: false, reason: 'invalid' });
    const state = await submitToken(OTHER);
    if (state.kind !== 'full') throw new Error('expected full');
    expect(state.masked).toContain('•');
    expect(state.masked).not.toBe(VALID);
  });

  it('差し替えに成功したら新しいトークンが保存される', async () => {
    const state = await submitToken(OTHER);
    expect(state.kind).toBe('full');
    await expect(getToken()).resolves.toBe(OTHER);
  });
});

describe('removeToken', () => {
  it('削除するとライトモードに戻り storage からも消える', async () => {
    // Arrange
    await saveToken(VALID);
    // Act
    const state = await removeToken();
    // Assert
    expect(state).toEqual({ kind: 'light' });
    await expect(getToken()).resolves.toBeNull();
  });
});
