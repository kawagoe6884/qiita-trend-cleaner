import { describe, it, expect, vi } from 'vitest';
import { badgeText, updateBadge } from './badge';

/**
 * バッジは 1 つしかない。**Phase 7 の除外件数バッジもこの優先順位の上に載せる**ので、
 * 規則そのものをここで固定しておく。
 */
describe('badgeText', () => {
  it('429 中は記号を出す（残り時間は入らない）', () => {
    // Arrange & Act & Assert — 候補件数より 429 が優先
    expect(badgeText(5, true)).toBe('!');
    expect(badgeText(0, true)).toBe('!');
  });

  it('429 でなければ候補件数を出す', () => {
    expect(badgeText(5, false)).toBe('5');
    expect(badgeText(1, false)).toBe('1');
  });

  it('候補ゼロなら空にする（前回の件数を残さない）', () => {
    expect(badgeText(0, false)).toBe('');
  });

  it('4 文字を超える表示にしない', () => {
    // バッジに入るのは実質 4 文字。件数が増えても崩れないこと
    expect(badgeText(9999, false).length).toBeLessThanOrEqual(4);
  });
});

describe('updateBadge', () => {
  it('計算した文字列を chrome.action に渡す', async () => {
    await updateBadge(3, false);
    expect(vi.mocked(chrome.action.setBadgeText)).toHaveBeenCalledWith({ text: '3' });
  });

  it('失敗しても例外を投げない（バッジが出ないだけ）', async () => {
    // Arrange
    vi.mocked(chrome.action.setBadgeText).mockRejectedValue(new Error('boom'));
    // Act & Assert — 呼び出し側の処理そのものは成立している
    await expect(updateBadge(1, false)).resolves.toBeUndefined();
  });
});
