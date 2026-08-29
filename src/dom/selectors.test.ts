import { describe, it, expect } from 'vitest';
import { SELECTORS, SNACKBAR_TEXT, MENU_TEXT, readSnackbarMessage } from './selectors';
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

/**
 * ⚠️ ブロックはミュートの **直上** にある。取り違えると native alert() が出て
 * 閉じられず、解除用の一覧 URL も無いので回収できない（設計上の約束 7）。
 */
describe('MENU_TEXT', () => {
  it('ミュートとブロックが別々の文字列である', () => {
    expect(MENU_TEXT.mute).not.toBe(MENU_TEXT.block);
  });

  it('ミュートとブロックの文言が互いを部分文字列として含まない', () => {
    // 完全一致で選ぶ根拠。片方がもう片方を含むと、実装を includes に
    // 変えたときに気づけなくなる
    expect(MENU_TEXT.mute.includes(MENU_TEXT.block)).toBe(false);
    expect(MENU_TEXT.block.includes(MENU_TEXT.mute)).toBe(false);
  });

  /**
   * 解除側の文言（2026-08-29 に追加）。**読むためだけに持つ。**
   *
   * `findMuteItem` は `endsWith(MENU_TEXT.mute)` で押す対象を決める。
   * ここが崩れると**解除を押してミュートを外す** — つまり「妥当」と評価した
   * 著者がトレンドに戻ってくる。文言が変わったら気づけるよう機械的に固定する。
   */
  it('解除の文言はミュートの文言で終わらない（endsWith で選んでも押さない）', () => {
    expect(MENU_TEXT.unmute.endsWith(MENU_TEXT.mute)).toBe(false);
  });

  it('ミュートの文言は解除の文言で終わらない（逆向きも塞ぐ）', () => {
    expect(MENU_TEXT.mute.endsWith(MENU_TEXT.unmute)).toBe(false);
  });

  it('ブロックと解除も別物である', () => {
    expect(MENU_TEXT.unmute).not.toBe(MENU_TEXT.block);
    expect(MENU_TEXT.unmute.includes(MENU_TEXT.block)).toBe(false);
  });

  /**
   * ユーザーページの文言（「ミュートする」「ミュートを解除する」）は**持たない。**
   * 拡張はユーザーページを開かないうえ、**両ページの文言が一文字も重ならないこと
   * 自体が、誤ってその DOM を掴んでも何も押さない保証**になっている。
   */
  it('ユーザーページの文言を持ち込んでいない', () => {
    const values: string[] = Object.values(MENU_TEXT);
    expect(values).not.toContain('ミュートする');
    expect(values).not.toContain('ミュートを解除する');
    // 末尾一致で選ぶので、「ミュートする」で終わる値があってはならない
    expect(values.filter((value) => value.endsWith('ミュートする'))).toEqual([]);
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
    // lookbackDays は 3 だった。フルモードが辿る過去記事は定義上「過去」で、
    // 3 日ではほぼ確実に窓の外に出る（2026-08-23 実測）。RETENTION_DAYS と
    // 同値の 7 にして、取得したものを捨てないようにした
    expect(DEFAULT_SETTINGS).toEqual({
      minClusterSize: 5,
      minSharedItems: 2,
      lookbackDays: 7,
      // Phase 9 で開放した項目。**60 → 180 はユーザー確定の変更**。
      // 候補の件数は変わらない（下限は撤回済み）が、スコア表示と
      // 並び順のタイブレークは変わる
      burstWindowMinutes: 180,
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
