import { describe, it, expect } from 'vitest';
import { scoreAiStyle, extractProse, isShortProse, isAiLikely, purgeAiHints } from './ai-style';
import { AI_HINT_DEFAULT_THRESHOLD, AI_HINT_MIN_PROSE_CHARS, AI_SIGNALS } from '../types/domain';
import type { AiHint } from '../types/domain';

/** 読点も記号も無い、どのシグナルも立てない 1 文（20 字） */
const PLAIN = 'これは確認のための平らな文でありますよ。';

/** PLAIN を n 文、段落として並べる */
function plain(n: number): string {
  return Array.from({ length: n }, () => PLAIN).join('\n');
}

/** 「使わない」シグナルを倒すための 1 文（感嘆符） */
const EXCLAIM = 'うまく動きました！';

function hint(fired: AiHint['fired'], proseChars = 1000): AiHint {
  return { fired, proseChars, scoredAt: '2026-10-24T00:00:00.000Z' };
}

describe('extractProse', () => {
  it('フェンス付きコードブロックを除く', () => {
    // Arrange
    const md = [
      '前の文です。',
      '```js:index.js',
      'const a = "、、、";',
      '```',
      '後の文です。',
    ].join('\n');
    // Act
    const prose = extractProse(md);
    // Assert
    expect(prose.lines.join('')).not.toContain('const');
    expect(prose.lines).toEqual(['前の文です。', '後の文です。']);
  });

  it('チルダのフェンスも除く', () => {
    const md = ['~~~', '— ダッシュ入りのコード', '~~~', '本文です。'].join('\n');
    expect(extractProse(md).lines).toEqual(['本文です。']);
  });

  it('インラインコード・表・引用・URL・画像を除き、リンクは文字だけ残す', () => {
    // Arrange
    const md = [
      '`npm、install` を実行します。',
      '| 列、A | 列、B |',
      '|---|---|',
      '> 引用、です。',
      '詳しくは [公式、ドキュメント](https://example.com/a) を見ます。',
      '![図](https://example.com/b.png)',
      'https://example.com/c',
    ].join('\n');
    // Act
    const { lines } = extractProse(md);
    // Assert
    expect(lines).toEqual(['を実行します。', '詳しくは 公式、ドキュメント を見ます。']);
  });

  it('Qiita の :::note の囲みは記号だけ除き、中身は地の文として残す', () => {
    const md = [':::note info', '補足の文です。', ':::'].join('\n');
    expect(extractProse(md).lines).toEqual(['補足の文です。']);
  });

  it('見出しは地の文に含めず、見出しとして別に持つ', () => {
    const md = ['## まとめ', '本文です。'].join('\n');
    const prose = extractProse(md);
    expect(prose.lines).toEqual(['本文です。']);
    expect(prose.headings).toEqual(['まとめ']);
  });

  it('箇条書きの行を数え、記号を除いた中身を地の文に残す', () => {
    const md = ['- 一つ目です', '* 二つ目です', '1. 三つ目です', '普通の文です。'].join('\n');
    const prose = extractProse(md);
    expect(prose.bulletLines).toBe(3);
    expect(prose.lines).toEqual(['一つ目です', '二つ目です', '三つ目です', '普通の文です。']);
  });

  it('太字を数え、記号を除く', () => {
    const md = '**重要**な点と __注意__ する点があります。';
    const prose = extractProse(md);
    expect(prose.boldCount).toBe(2);
    expect(prose.lines).toEqual(['重要な点と 注意 する点があります。']);
  });

  it('入れ子のタグでも < と > を残さない（CodeQL: 不完全な複数文字の除去）', () => {
    // Arrange — 1 回の置換では「<script」が残る形
    const md = '<scr<script>ipt>本文です。';
    // Act
    const { lines } = extractProse(md);
    // Assert
    expect(lines.join('')).not.toMatch(/[<>]/);
    expect(lines.join('')).toContain('本文です。');
  });

  it('HTML タグを除く', () => {
    expect(extractProse('<details><summary>開く</summary></details>').lines).toEqual(['開く']);
  });
});

describe('scoreAiStyle', () => {
  it('どのシグナルも立たない文章は 0 点（感嘆符があるので「減った表現を使わない」も立たない）', () => {
    // Arrange
    const md = [plain(30), EXCLAIM].join('\n');
    // Act
    const result = scoreAiStyle(md);
    // Assert
    expect(result.fired).toEqual([]);
  });

  it('地の文の文字数は空白を除いて数える', () => {
    expect(scoreAiStyle('あい う\nえ　お').proseChars).toBe(5);
  });

  it('コードだけの記事は 0 文字になる', () => {
    expect(scoreAiStyle(['```', 'const x = 1;', '```'].join('\n')).proseChars).toBe(0);
  });

  describe('commaDensity（1 文あたりの読点）', () => {
    it('PRD の例文（1 文に読点 2 つ）だけなら立つ', () => {
      const md = 'この記事では、実際にどんな指示を出して、どんなものができたのかを紹介します。';
      expect(scoreAiStyle(md).fired).toContain('commaDensity');
    });

    it('1 文に読点 1 つ以下なら立たない（AI 以前の 0.63 と以後の 0.95 の中点 0.79 を超えない）', () => {
      const md = ['前置き、本文です。', '本文です。'].join('\n');
      expect(scoreAiStyle(md).fired).not.toContain('commaDensity');
    });

    it('全角カンマも読点として数える', () => {
      const md = 'これは，あれと，それです。';
      expect(scoreAiStyle(md).fired).toContain('commaDensity');
    });
  });

  describe('boldDensity（1000 字あたりの太字）', () => {
    it('1000 字あたり 2.5 個を超えたら立つ', () => {
      // 20 字 × 10 文 = 200 字に太字 1 個 → 5 個 / 1000 字
      const md = ['**強調**', plain(10)].join('\n');
      expect(scoreAiStyle(md).fired).toContain('boldDensity');
    });

    it('1000 字あたり 2.5 個以下なら立たない', () => {
      // 20 字 × 50 文 = 1000 字に太字 2 個
      const md = ['**一**', '**二**', plain(50)].join('\n');
      expect(scoreAiStyle(md).fired).not.toContain('boldDensity');
    });
  });

  describe('bulletRatio（箇条書きの行の比率）', () => {
    it('地の文の行の 12.5% を超えたら立つ', () => {
      const md = ['- 項目です', plain(5)].join('\n');
      expect(scoreAiStyle(md).fired).toContain('bulletRatio');
    });

    it('12.5% 以下なら立たない', () => {
      const md = ['- 項目です', plain(9)].join('\n');
      expect(scoreAiStyle(md).fired).not.toContain('bulletRatio');
    });
  });

  describe('dash', () => {
    it('全角ダッシュ（—）が 1 つでもあれば立つ', () => {
      expect(scoreAiStyle('これは — 補足です。').fired).toContain('dash');
    });

    it('水平線（―）でも立つ', () => {
      expect(scoreAiStyle('これは―補足です。').fired).toContain('dash');
    });

    it('ハイフンや長音では立たない', () => {
      expect(scoreAiStyle('サーバー - クライアント').fired).not.toContain('dash');
    });
  });

  describe('summaryHeading', () => {
    it('見出しに「まとめ」があれば立つ', () => {
      expect(scoreAiStyle(['# 今回のまとめ', PLAIN].join('\n')).fired).toContain('summaryHeading');
    });

    it('本文中の「まとめ」では立たない', () => {
      expect(scoreAiStyle('結果をまとめます。').fired).not.toContain('summaryHeading');
    });
  });

  describe('risingWords', () => {
    it.each(['効く', '効いた', '既定', '実測', '入口', '事故', '別物'])('「%s」で立つ', (word) => {
      expect(scoreAiStyle(`これは${word}の話です。`).fired).toContain('risingWords');
    });

    it('コードの中の語では立たない', () => {
      const md = ['```', '// 既定の値', '```', PLAIN].join('\n');
      expect(scoreAiStyle(md).fired).not.toContain('risingWords');
    });
  });

  describe('noFallingExpressions', () => {
    it('しましょう・感嘆符・「また、」のどれも無ければ立つ', () => {
      expect(scoreAiStyle(PLAIN).fired).toContain('noFallingExpressions');
    });

    it.each(['試してみましょう。', 'できました！', 'Done!', 'また、別の話です。'])(
      '「%s」があれば立たない',
      (sentence) => {
        expect(scoreAiStyle([PLAIN, sentence].join('\n')).fired).not.toContain(
          'noFallingExpressions',
        );
      },
    );

    it('画像記法の ! では倒れない', () => {
      const md = [PLAIN, '![図](https://example.com/a.png)'].join('\n');
      expect(scoreAiStyle(md).fired).toContain('noFallingExpressions');
    });
  });

  describe('longProse', () => {
    it('地の文が 1445 字以上なら立つ（AI 以前 976 字と以後 1914 字の中点）', () => {
      // 20 字 × 73 = 1460 字
      expect(scoreAiStyle(plain(73)).fired).toContain('longProse');
    });

    it('1445 字未満なら立たない', () => {
      // 20 字 × 72 = 1440 字
      expect(scoreAiStyle(plain(72)).fired).not.toContain('longProse');
    });
  });

  it('立ったシグナルは AI_SIGNALS の順に並ぶ', () => {
    const md = ['## まとめ', '**実測**では、これが、効く — と分かった。'].join('\n');
    const { fired } = scoreAiStyle(md);
    const order = fired.map((signal) => AI_SIGNALS.indexOf(signal));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('isShortProse', () => {
  it(`${String(AI_HINT_MIN_PROSE_CHARS)} 字未満なら短文`, () => {
    expect(isShortProse(hint([], AI_HINT_MIN_PROSE_CHARS - 1))).toBe(true);
  });

  it(`ちょうど ${String(AI_HINT_MIN_PROSE_CHARS)} 字なら短文ではない`, () => {
    expect(isShortProse(hint([], AI_HINT_MIN_PROSE_CHARS))).toBe(false);
  });

  it('最小文字数を引数で変えられる', () => {
    expect(isShortProse(hint([], 499), 500)).toBe(true);
    expect(isShortProse(hint([], 500), 500)).toBe(false);
  });

  it('最小文字数 0 なら地の文が 0 字でも短文としない（注釈を出さない）', () => {
    expect(isShortProse(hint([], 0), 0)).toBe(false);
  });
});

describe('isAiLikely', () => {
  it('閾値ちょうどの点数なら強調する', () => {
    const fired = AI_SIGNALS.slice(0, AI_HINT_DEFAULT_THRESHOLD);
    expect(isAiLikely(hint([...fired]))).toBe(true);
  });

  it('閾値未満なら強調しない', () => {
    const fired = AI_SIGNALS.slice(0, AI_HINT_DEFAULT_THRESHOLD - 1);
    expect(isAiLikely(hint([...fired]))).toBe(false);
  });

  it('閾値を引数で変えられる', () => {
    expect(isAiLikely(hint(['dash']), 1)).toBe(true);
  });
});

describe('purgeAiHints', () => {
  const now = new Date('2026-10-24T00:00:00.000Z');

  function at(scoredAt: string): AiHint {
    return { fired: [], proseChars: 500, scoredAt };
  }

  it('保持期間（7 日）以内のスコアは残し、過ぎたものは捨てる', () => {
    // Arrange
    const log = {
      fresh: at('2026-10-20T00:00:00.000Z'),
      edge: at('2026-10-17T00:00:00.000Z'),
      stale: at('2026-10-16T23:59:59.000Z'),
    };
    // Act
    const kept = purgeAiHints(log, now);
    // Assert
    expect(Object.keys(kept).sort()).toEqual(['edge', 'fresh']);
  });

  it('時刻が読めないスコアは捨てる（取り直せば戻る）', () => {
    expect(purgeAiHints({ broken: at('not-a-date') }, now)).toEqual({});
  });

  it('引数を書き換えない', () => {
    const log = { stale: at('2026-01-01T00:00:00.000Z') };
    purgeAiHints(log, now);
    expect(Object.keys(log)).toEqual(['stale']);
  });
});
