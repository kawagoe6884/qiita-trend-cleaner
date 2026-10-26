import { describe, it, expect } from 'vitest';
import {
  describeAgreementCell,
  describeAgreementSummary,
  describeLegacy,
} from './ai-agreement-copy';
import type { Agreement } from '../../detect/ai-agreement';

function agreement(answered: number, agreed: number, threshold = 5): Agreement {
  return { threshold, answered, agreed, ratio: answered === 0 ? null : agreed / answered };
}

describe('describeAgreementSummary', () => {
  it('回答が無ければ、どこで答えるかを案内する', () => {
    const text = describeAgreementSummary(agreement(0, 0));
    expect(text).toContain('まだ回答がありません');
    expect(text).toContain('そうかも / 違うかも');
  });

  it('30 件未満は % を出しつつ、判定はせずに残りの件数を出す', () => {
    const text = describeAgreementSummary(agreement(12, 9));
    expect(text).toBe(
      'いまの基準（5 点以上）: 12 件中 9 件が一致（75%）。あと 18 件で判定します。',
    );
  });

  it('30 件で 70% 以上なら目標に届いたと出す', () => {
    expect(describeAgreementSummary(agreement(30, 21))).toBe(
      'いまの基準（5 点以上）: 30 件中 21 件が一致（70%）。目標の 70% に届いています。',
    );
  });

  it('30 件で 70% 未満なら、表で探せることを添える', () => {
    const text = describeAgreementSummary(agreement(30, 15));
    expect(text).toContain('目標の 70% に届いていません');
    expect(text).toContain('下の表');
  });
});

describe('describeAgreementCell', () => {
  it('割合と内訳を出す', () => {
    expect(describeAgreementCell(agreement(8, 6))).toBe('75%（6 / 8）');
  });

  it('回答が無ければ — にする（0% にしない）', () => {
    expect(describeAgreementCell(agreement(0, 0))).toBe('—');
  });

  it('割合は四捨五入した整数', () => {
    expect(describeAgreementCell(agreement(3, 2))).toBe('67%（2 / 3）');
  });
});

describe('describeLegacy', () => {
  it('旧形式が無ければ null（何も出さない）', () => {
    expect(describeLegacy(0)).toBeNull();
  });

  it('旧形式の件数と、集計に入れない理由を出す', () => {
    const text = describeLegacy(4);
    expect(text).toContain('4 件');
    expect(text).toContain('集計に入れていません');
  });
});
