import { describe, it, expect } from 'vitest';
import { SELECTORS, SNACKBAR_TEXT, readSnackbarMessage } from './selectors';
import { DEFAULT_SETTINGS } from '../types/domain';

describe('SELECTORS', () => {
  it('CSS-in-JS のハッシュクラス名を含まない', () => {
    // Arrange
    const values: string[] = Object.values(SELECTORS);
    // Act
    const offenders = values.filter((value) => /\.style-/.test(value));
    // Assert
    expect(offenders).toEqual([]);
  });

  it('クラスセレクタを一切使っていない', () => {
    const values: string[] = Object.values(SELECTORS);
    const offenders = values.filter((value) => value.includes('.'));
    expect(offenders).toEqual([]);
  });
});

describe('readSnackbarMessage', () => {
  it('ミュート完了メッセージを読み取れる', () => {
    // Arrange — class 属性は意図的に付けない（クラス名非依存の証明）
    document.body.innerHTML = `
      <div id="Snackbar-react-component-5c3764b3-27d6-4d3a-9c08-7437191f2087">
        <div aria-live="polite" aria-atomic="true">
          <div><span aria-hidden="true">check_circle</span><p>ミュートが完了しました</p></div>
        </div>
      </div>`;
    // Act
    const message = readSnackbarMessage();
    // Assert
    expect(message).toBe(SNACKBAR_TEXT.muteCompleted);
  });

  it('uuid が異なっても id プレフィックスで一致する', () => {
    document.body.innerHTML = `
      <div id="Snackbar-react-component-00000000-1111-2222-3333-444444444444">
        <div aria-live="polite" aria-atomic="true"><div><p>ミュートの解除が完了しました</p></div></div>
      </div>`;
    expect(readSnackbarMessage()).toBe(SNACKBAR_TEXT.unmuteCompleted);
  });

  it('Snackbar が無ければ null を返し、例外を投げない', () => {
    document.body.innerHTML = '';
    expect(() => readSnackbarMessage()).not.toThrow();
    expect(readSnackbarMessage()).toBeNull();
  });

  it('メッセージ要素が欠けていても null を返す', () => {
    document.body.innerHTML = `
      <div id="Snackbar-react-component-abc">
        <div aria-live="polite" aria-atomic="true"></div>
      </div>`;
    expect(readSnackbarMessage()).toBeNull();
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('PRD が定めた既定値と一致する', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      minClusterSize: 5,
      minSharedItems: 2,
      lookbackDays: 3,
    });
  });
});

describe('chrome mock', () => {
  it('storage.local が set した値を get で返す', async () => {
    await chrome.storage.local.set({ rateLimitedUntil: 1787104432 });
    const result = await chrome.storage.local.get('rateLimitedUntil');
    expect(result).toEqual({ rateLimitedUntil: 1787104432 });
  });
});
