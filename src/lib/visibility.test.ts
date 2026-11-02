import { describe, it, expect } from 'vitest';
import { isHiddenAsOffTrend } from './visibility';

/**
 * ポップアップの一覧（popup-state の hideOffTrend）とバッジ（background の
 * badge-sync）が**同じ規則**で数えるための判定。片方だけ変えると、一覧の件数と
 * バッジが食い違う（2026-11-02 に 2 箇所へ同じ式を書いていたのを 1 つにした）。
 */
describe('isHiddenAsOffTrend', () => {
  const AT = '2026-11-02T12:53:00.000Z';

  it('トレンドに居れば隠さない', () => {
    expect(isHiddenAsOffTrend(false, null)).toBe(false);
  });

  it('トレンドに居ず、ミュートの記録も無ければ隠す', () => {
    expect(isHiddenAsOffTrend(true, null)).toBe(true);
    expect(isHiddenAsOffTrend(true, undefined)).toBe(true);
  });

  it('★ ミュート済みと確認できていれば、トレンドに居なくても隠さない', () => {
    // Arrange — ミュートすると次の読み込みからトレンドに出なくなる。隠すと
    // 誤検知でミュートした著者を「誤り」に直す道が消える（OQ-16）
    const record = { outcome: 'muted' as const, at: AT, mutedAt: AT };
    // Act & Assert
    expect(isHiddenAsOffTrend(true, record)).toBe(false);
  });

  it('★ 試しただけで確認できていない記録なら隠す（理由の説明にならない）', () => {
    expect(isHiddenAsOffTrend(true, { outcome: 'not-on-page', at: AT })).toBe(true);
    expect(isHiddenAsOffTrend(true, { outcome: 'menu-unavailable', at: AT })).toBe(true);
  });

  it('★ 確認済みのあとで見送りを記録しても、mutedAt が残っていれば隠さない', () => {
    // Arrange — recordMuteOutcome は見送り（not-on-page）を書いても mutedAt を消さない。
    // outcome で判定すると、「誤り」→「妥当」と押し直した瞬間に一覧から消える
    const record = { outcome: 'not-on-page' as const, at: AT, mutedAt: AT };
    // Act & Assert
    expect(isHiddenAsOffTrend(true, record)).toBe(false);
  });
});
