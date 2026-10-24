import { describe, it, expect } from 'vitest';
import {
  agreementAt,
  agreementByThreshold,
  countLegacyAnswers,
  judgeAgreement,
} from './ai-agreement';
import {
  AI_HINT_TARGET_ANSWERS,
  AI_HINT_THRESHOLD_RANGE,
  type AiAnswer,
  type AiVerdict,
  type AiVerdictLog,
} from '../types/domain';

/** 合成の回答。記事 ID は連番 */
function answer(verdict: AiVerdict, score: number | null): AiAnswer {
  return {
    verdict,
    score,
    answeredAt: score === null ? null : '2026-10-24T00:00:00.000Z',
  };
}

function logOf(...answers: AiAnswer[]): AiVerdictLog {
  return Object.fromEntries(answers.map((entry, index) => [`item-${String(index)}`, entry]));
}

describe('agreementAt', () => {
  it.each([
    // 予測（点数 >= 線引き）と答え（そうかも）の 4 通り
    { score: 6, verdict: 'yes', agreed: 1, label: '強調して「そうかも」は一致' },
    { score: 6, verdict: 'no', agreed: 0, label: '強調して「違うかも」は不一致' },
    { score: 2, verdict: 'yes', agreed: 0, label: '強調せず「そうかも」は不一致（見逃し）' },
    { score: 2, verdict: 'no', agreed: 1, label: '強調せず「違うかも」は一致' },
  ] as const)('$label', ({ score, verdict, agreed }) => {
    const result = agreementAt(logOf(answer(verdict, score)), 5);
    expect(result).toEqual({ threshold: 5, answered: 1, agreed, ratio: agreed });
  });

  it('点数がちょうど線引きなら強調とみなす', () => {
    expect(agreementAt(logOf(answer('yes', 5)), 5).agreed).toBe(1);
  });

  it('線引きを変えると同じ回答から別の一致率になる', () => {
    // Arrange — 4 点の記事を「そうかも」と答えた
    const log = logOf(answer('yes', 4), answer('no', 1));
    // Act & Assert
    expect(agreementAt(log, 5).ratio).toBe(0.5);
    expect(agreementAt(log, 4).ratio).toBe(1);
  });

  it('旧形式（点数なし）の回答は数えない', () => {
    const log = logOf(answer('yes', null), answer('yes', 6));
    expect(agreementAt(log, 5)).toEqual({ threshold: 5, answered: 1, agreed: 1, ratio: 1 });
  });

  it('回答が無ければ一致率は null（0% にしない）', () => {
    expect(agreementAt({}, 5)).toEqual({ threshold: 5, answered: 0, agreed: 0, ratio: null });
  });
});

describe('agreementByThreshold', () => {
  it('線引きの全範囲（1〜8 点）を小さい順に返す', () => {
    // Act
    const rows = agreementByThreshold(logOf(answer('yes', 3)));
    // Assert
    expect(rows.map((row) => row.threshold)).toEqual(
      Array.from(
        { length: AI_HINT_THRESHOLD_RANGE.max - AI_HINT_THRESHOLD_RANGE.min + 1 },
        (_, index) => AI_HINT_THRESHOLD_RANGE.min + index,
      ),
    );
    // 3 点で「そうかも」→ 線引き 3 以下なら一致、4 以上なら不一致
    expect(rows.find((row) => row.threshold === 3)?.agreed).toBe(1);
    expect(rows.find((row) => row.threshold === 4)?.agreed).toBe(0);
  });
});

describe('countLegacyAnswers', () => {
  it('点数の無い旧形式の回答だけを数える', () => {
    expect(
      countLegacyAnswers(logOf(answer('yes', null), answer('no', null), answer('yes', 3))),
    ).toBe(2);
  });
});

describe('judgeAgreement', () => {
  function agreement(answered: number, agreed: number) {
    return {
      threshold: 5,
      answered,
      agreed,
      ratio: answered === 0 ? null : agreed / answered,
    };
  }

  it('目標の件数に届くまでは判定せず、あと何件かを返す', () => {
    // 29 件で 100% でも判定しない — 分母が小さいうちに % で判断させない
    expect(
      judgeAgreement(agreement(AI_HINT_TARGET_ANSWERS - 1, AI_HINT_TARGET_ANSWERS - 1)),
    ).toEqual({ kind: 'pending', remaining: 1 });
    expect(judgeAgreement(agreement(0, 0))).toEqual({
      kind: 'pending',
      remaining: AI_HINT_TARGET_ANSWERS,
    });
  });

  it('30 件で 70% ちょうどなら達成', () => {
    expect(judgeAgreement(agreement(30, 21))).toEqual({ kind: 'met' });
  });

  it('30 件で 70% 未満なら未達', () => {
    expect(judgeAgreement(agreement(30, 20))).toEqual({ kind: 'unmet' });
  });
});
