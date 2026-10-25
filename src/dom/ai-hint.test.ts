import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderAiHints, clearAiHints, describeAiHint, isOwnMutation } from './ai-hint';
import { AI_HINT_STYLE_ID } from './selectors';
import {
  AI_HINT_DEFAULT_THRESHOLD,
  AI_HINT_MIN_PROSE_CHARS,
  AI_SIGNALS,
  DEFAULT_AI_HINT_PREFS,
} from '../types/domain';
import type { AiAnswer, AiHint, AiHintLog, AiVerdict, AiVerdictLog } from '../types/domain';

/** hider.test.ts と同じ骨格。実測どおり記事リンクを 2 本持たせる。合成値のみ */
function card(n: number): string {
  const author = `example-author-${String(n)}`;
  const url = `https://qiita.com/${author}/items/${itemIdOf(n)}`;
  return `<div class="card"><a href="${url}"></a><time datetime="2026-08-18T10:00:00Z">2026年08月18日</time><a href="${url}">タイトル ${String(n)}</a></div>`;
}

function itemIdOf(n: number): string {
  return `0123456789abcdef${String(n).padStart(4, '0')}`;
}

function hint(score: number, proseChars = 1000): AiHint {
  return {
    fired: AI_SIGNALS.slice(0, score),
    proseChars,
    scoredAt: '2026-10-24T00:00:00.000Z',
  };
}

/** 合成の回答（M3 の形式） */
function answerOf(verdict: AiVerdict, score: number | null = 5): AiAnswer {
  return {
    verdict,
    score,
    fired: null,
    answeredAt: score === null ? null : '2026-10-24T00:00:00.000Z',
  };
}

function hintsOn(n: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-qtg-ai-hint="${itemIdOf(n)}"]`);
}

function buttonOf(n: number, label: 'そうかも' | '違うかも'): HTMLButtonElement | undefined {
  return [...(hintsOn(n)?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === label,
  );
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('renderAiHints', () => {
  it('スコアのある全記事に「AI文体かも？」を出す（閾値未満も含む）', () => {
    // Arrange
    document.body.innerHTML = card(1) + card(2);
    const hints: AiHintLog = { [itemIdOf(1)]: hint(8), [itemIdOf(2)]: hint(0) };
    // Act
    const rendered = renderAiHints(hints, {}, vi.fn());
    // Assert
    expect(rendered).toBe(2);
    for (const n of [1, 2]) {
      expect(hintsOn(n)?.textContent).toContain('AI文体かも？');
      expect(buttonOf(n, 'そうかも')).toBeDefined();
      expect(buttonOf(n, '違うかも')).toBeDefined();
    }
  });

  it('スコアの無い記事には何も出さない', () => {
    document.body.innerHTML = card(1);
    expect(renderAiHints({}, {}, vi.fn())).toBe(0);
    expect(hintsOn(1)).toBeNull();
  });

  it('閾値以上は強調し、未満は控えめにする', () => {
    // Arrange
    document.body.innerHTML = card(1) + card(2);
    const hints: AiHintLog = {
      [itemIdOf(1)]: hint(AI_HINT_DEFAULT_THRESHOLD),
      [itemIdOf(2)]: hint(AI_HINT_DEFAULT_THRESHOLD - 1),
    };
    // Act
    renderAiHints(hints, {}, vi.fn());
    // Assert
    expect(hintsOn(1)?.dataset.qtgAiLikely).toBe('true');
    expect(hintsOn(2)?.dataset.qtgAiLikely).toBe('false');
  });

  it('地の文が短い記事には「判定が甘い可能性あり」と注釈する', () => {
    // Arrange
    document.body.innerHTML = card(1) + card(2);
    const hints: AiHintLog = {
      [itemIdOf(1)]: hint(3, AI_HINT_MIN_PROSE_CHARS - 1),
      [itemIdOf(2)]: hint(3, AI_HINT_MIN_PROSE_CHARS),
    };
    // Act
    renderAiHints(hints, {}, vi.fn());
    // Assert
    expect(hintsOn(1)?.textContent).toContain('判定が甘い可能性あり');
    expect(hintsOn(2)?.textContent).not.toContain('判定が甘い可能性あり');
  });

  it('点数は断定せずに title で示す', () => {
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(3) }, {}, vi.fn());
    expect(hintsOn(1)?.title).toBe(describeAiHint(hint(3)));
    expect(hintsOn(1)?.title).toContain(`3 / ${String(AI_SIGNALS.length)}`);
  });

  it('押したボタンで記事 ID と回答を渡し、リンクの遷移を止める', () => {
    // Arrange
    document.body.innerHTML = card(1);
    const onAnswer = vi.fn();
    renderAiHints({ [itemIdOf(1)]: hint(5) }, {}, onAnswer);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    // Act
    buttonOf(1, '違うかも')?.dispatchEvent(event);
    // Assert
    expect(onAnswer).toHaveBeenCalledWith(itemIdOf(1), 'no', AI_SIGNALS.slice(0, 5));
    expect(event.defaultPrevented).toBe(true);
  });

  it('回答済みの側を aria-pressed で示す', () => {
    document.body.innerHTML = card(1);
    const verdicts: AiVerdictLog = { [itemIdOf(1)]: answerOf('yes') };
    renderAiHints({ [itemIdOf(1)]: hint(5) }, verdicts, vi.fn());
    expect(buttonOf(1, 'そうかも')?.getAttribute('aria-pressed')).toBe('true');
    expect(buttonOf(1, '違うかも')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('ボタンは「そうかも / 違うかも」（判定口調にしない）', () => {
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(5) }, {}, vi.fn());
    const labels = [...(hintsOn(1)?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(labels).toEqual(['そうかも', '違うかも']);
  });

  it('押したときに回答時の点数を渡す（線引きを動かしても一致率を数え直せる）', () => {
    // Arrange
    document.body.innerHTML = card(1);
    const onAnswer = vi.fn();
    renderAiHints({ [itemIdOf(1)]: hint(3) }, {}, onAnswer);
    // Act
    buttonOf(1, 'そうかも')?.click();
    // Assert
    expect(onAnswer).toHaveBeenCalledWith(itemIdOf(1), 'yes', AI_SIGNALS.slice(0, 3));
  });

  it('M3 より前の旧形式の回答でも ✓ を出す', () => {
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(5) }, { [itemIdOf(1)]: answerOf('yes', null) }, vi.fn());
    expect(hintsOn(1)?.querySelector('.qtg-ai-done')?.textContent).toBe('✓');
    expect(buttonOf(1, 'そうかも')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('回答ボタンはラベルの左に置く（右端のラベルは動かず、乗せた位置で誤って押さない）', () => {
    // Arrange
    document.body.innerHTML = card(1);
    // Act
    renderAiHints({ [itemIdOf(1)]: hint(5) }, {}, vi.fn());
    // Assert
    const row = hintsOn(1)?.firstElementChild;
    expect(row?.firstElementChild?.classList.contains('qtg-ai-answers')).toBe(true);
    expect(row?.lastElementChild?.textContent).toBe('AI文体かも？');
  });

  it('回答ボタンは左へすべり出す（動きを減らす設定では動かさない）', () => {
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(5) }, {}, vi.fn());
    const css = document.getElementById(AI_HINT_STYLE_ID)?.textContent ?? '';
    expect(css).toContain('@keyframes');
    expect(css).toContain('translateX');
    expect(css).toContain('prefers-reduced-motion');
  });

  it('強調しない記事は普段は見せず、カードに乗せた時だけ出す（機能はそのまま）', () => {
    // Arrange
    document.body.innerHTML = card(1);
    // Act
    renderAiHints({ [itemIdOf(1)]: hint(1) }, {}, vi.fn());
    // Assert — :hover は jsdom で再現できないので、規則と目印を確かめる
    const element = hintsOn(1);
    expect(element).not.toBeNull();
    expect(element?.style.opacity).toBe('');
    expect(document.querySelector<HTMLElement>('.card')?.dataset.qtgAiCard).toBe('true');
    const css = document.getElementById(AI_HINT_STYLE_ID)?.textContent ?? '';
    expect(css).toMatch(/\[data-qtg-ai-likely="false"\]\s*\{[^}]*opacity:\s*0;/);
    expect(css).toContain('[data-qtg-ai-card]:hover');
    expect(buttonOf(1, 'そうかも')).toBeDefined();
  });

  it('見えていない間は Tab で止まらず、読み上げにも出ない（visibility: hidden）', () => {
    // Arrange — opacity: 0 だけだと、見えない要素に Tab で止まり、読み上げられる（コードレビュー LOW）
    document.body.innerHTML = card(1);
    // Act
    renderAiHints({ [itemIdOf(1)]: hint(1) }, {}, vi.fn());
    // Assert
    const css = document.getElementById(AI_HINT_STYLE_ID)?.textContent ?? '';
    expect(css).toMatch(/\[data-qtg-ai-likely="false"\]\s*\{[^}]*visibility:\s*hidden;/);
    // キーボードでカードの中（記事リンクなど）に入ったら見せる。そこから Tab で表示に進める
    expect(css).toContain('[data-qtg-ai-card]:focus-within');
    expect(css).toMatch(/\{[^}]*visibility:\s*visible;/);
  });

  it('回答済みの側をもう一度押すと、回答を取り消す（null を渡す）', () => {
    // Arrange
    document.body.innerHTML = card(1);
    const onAnswer = vi.fn();
    renderAiHints({ [itemIdOf(1)]: hint(4) }, { [itemIdOf(1)]: answerOf('yes') }, onAnswer);
    // Act
    buttonOf(1, 'そうかも')?.click();
    // Assert
    expect(onAnswer).toHaveBeenCalledWith(itemIdOf(1), null, AI_SIGNALS.slice(0, 4));
  });

  it('回答済みでも、反対側を押せば答えを変える', () => {
    document.body.innerHTML = card(1);
    const onAnswer = vi.fn();
    renderAiHints({ [itemIdOf(1)]: hint(4) }, { [itemIdOf(1)]: answerOf('yes') }, onAnswer);
    buttonOf(1, '違うかも')?.click();
    expect(onAnswer).toHaveBeenCalledWith(itemIdOf(1), 'no', AI_SIGNALS.slice(0, 4));
  });

  it('描き直しても二重にしない', () => {
    // Arrange
    document.body.innerHTML = card(1);
    const hints: AiHintLog = { [itemIdOf(1)]: hint(5) };
    // Act
    renderAiHints(hints, {}, vi.fn());
    renderAiHints(hints, { [itemIdOf(1)]: answerOf('no') }, vi.fn());
    // Assert
    expect(document.querySelectorAll('[data-qtg-ai-hint]')).toHaveLength(1);
    expect(buttonOf(1, '違うかも')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('カードの右上に重ねて置き、カードの高さを増やさない', () => {
    // Arrange
    document.body.innerHTML = card(1);
    // Act
    renderAiHints({ [itemIdOf(1)]: hint(5) }, {}, vi.fn());
    // Assert
    const element = hintsOn(1);
    expect(element?.style.position).toBe('absolute');
    expect(element?.style.top).not.toBe('');
    expect(element?.style.right).not.toBe('');
    expect(document.querySelector<HTMLElement>('.card')?.style.position).toBe('relative');
  });

  it('カードが既に位置指定されていれば position を上書きしない', () => {
    document.body.innerHTML = card(1);
    const target = document.querySelector<HTMLElement>('.card');
    if (target) target.style.position = 'sticky';
    renderAiHints({ [itemIdOf(1)]: hint(5) }, {}, vi.fn());
    expect(target?.style.position).toBe('sticky');
  });

  it('回答のボタンは普段は隠し、ラベルに乗せた時とフォーカスした時だけ出す', () => {
    // Arrange
    document.body.innerHTML = card(1);
    // Act
    renderAiHints({ [itemIdOf(1)]: hint(5) }, {}, vi.fn());
    // Assert — :hover は jsdom で再現できないので、規則が入っていることを確かめる
    const answers = hintsOn(1)?.querySelector('.qtg-ai-answers');
    expect(answers?.contains(buttonOf(1, 'そうかも') ?? null)).toBe(true);
    const css = document.getElementById(AI_HINT_STYLE_ID)?.textContent ?? '';
    expect(css).toMatch(/\.qtg-ai-answers\s*\{[^}]*display:\s*none/);
    expect(css).toContain(':hover .qtg-ai-answers');
    expect(css).toContain(':focus-within .qtg-ai-answers');
    expect(hintsOn(1)?.tabIndex).toBe(0);
  });

  it('スタイルは 1 つだけ入れる', () => {
    document.body.innerHTML = card(1) + card(2);
    renderAiHints({ [itemIdOf(1)]: hint(5), [itemIdOf(2)]: hint(1) }, {}, vi.fn());
    renderAiHints({ [itemIdOf(1)]: hint(5) }, {}, vi.fn());
    expect(document.querySelectorAll(`#${AI_HINT_STYLE_ID}`)).toHaveLength(1);
  });

  it('回答済みの記事にはラベルの横に ✓ だけを残す', () => {
    // Arrange
    document.body.innerHTML = card(1) + card(2);
    const hints: AiHintLog = { [itemIdOf(1)]: hint(5), [itemIdOf(2)]: hint(5) };
    // Act
    renderAiHints(hints, { [itemIdOf(1)]: answerOf('no') }, vi.fn());
    // Assert
    expect(hintsOn(1)?.querySelector('.qtg-ai-done')?.textContent).toBe('✓');
    expect(hintsOn(2)?.querySelector('.qtg-ai-done')).toBeNull();
  });

  it('線引きを渡すと、その点数以上を強調する', () => {
    // Arrange
    document.body.innerHTML = card(1) + card(2);
    const hints: AiHintLog = { [itemIdOf(1)]: hint(3), [itemIdOf(2)]: hint(2) };
    // Act
    renderAiHints(hints, {}, vi.fn(), {
      threshold: 3,
      minProseChars: AI_HINT_MIN_PROSE_CHARS,
      dimLikely: false,
    });
    // Assert
    expect(hintsOn(1)?.dataset.qtgAiLikely).toBe('true');
    expect(hintsOn(2)?.dataset.qtgAiLikely).toBe('false');
  });

  it('線引きを上げて描き直すと強調が外れる', () => {
    document.body.innerHTML = card(1);
    const hints: AiHintLog = { [itemIdOf(1)]: hint(5) };
    renderAiHints(hints, {}, vi.fn());
    expect(hintsOn(1)?.dataset.qtgAiLikely).toBe('true');
    renderAiHints(hints, {}, vi.fn(), {
      threshold: 6,
      minProseChars: AI_HINT_MIN_PROSE_CHARS,
      dimLikely: false,
    });
    expect(hintsOn(1)?.dataset.qtgAiLikely).toBe('false');
    expect(document.querySelectorAll('[data-qtg-ai-hint]')).toHaveLength(1);
  });

  it('最小文字数を渡すと、それ未満にだけ注釈を付ける', () => {
    // Arrange
    document.body.innerHTML = card(1) + card(2);
    const hints: AiHintLog = { [itemIdOf(1)]: hint(3, 499), [itemIdOf(2)]: hint(3, 500) };
    // Act
    renderAiHints(hints, {}, vi.fn(), {
      threshold: AI_HINT_DEFAULT_THRESHOLD,
      minProseChars: 500,
      dimLikely: false,
    });
    // Assert
    expect(hintsOn(1)?.textContent).toContain('判定が甘い可能性あり');
    expect(hintsOn(2)?.textContent).not.toContain('判定が甘い可能性あり');
  });

  it('最小文字数 0 なら注釈を出さない', () => {
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(3, 0) }, {}, vi.fn(), {
      threshold: AI_HINT_DEFAULT_THRESHOLD,
      minProseChars: 0,
      dimLikely: false,
    });
    expect(hintsOn(1)?.textContent).not.toContain('判定が甘い可能性あり');
  });

  it('短文の注釈はラベルの行とは別の行に置く', () => {
    // Arrange
    document.body.innerHTML = card(1);
    // Act
    renderAiHints({ [itemIdOf(1)]: hint(3, AI_HINT_MIN_PROSE_CHARS - 1) }, {}, vi.fn());
    // Assert
    const container = hintsOn(1);
    const rows = [...(container?.children ?? [])];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('AI文体かも？');
    expect(rows[1]?.textContent).toBe('（短文のため判定が甘い可能性あり）');
  });

  it('表示を足してもカードの記事リンクは増えない（カード判定を壊さない）', () => {
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(5) }, {}, vi.fn());
    expect(document.querySelectorAll('a[href*="/items/"]')).toHaveLength(2);
  });
});

/**
 * 描き直しの監視が、自分の描画に反応して止まらなくなるのを防ぐ判定。
 * MutationObserver の記録を jsdom で実際に作って確かめる。
 */
/** 強調される記事を薄く表示する（M4）。カードに印を付け、head の規則で薄くする */
describe('renderAiHints（薄く表示する）', () => {
  const dimOn = { ...DEFAULT_AI_HINT_PREFS, dimLikely: true };

  function cardOf(n: number): HTMLElement | null | undefined {
    return hintsOn(n)?.parentElement;
  }

  it('既定（オフ）ではどのカードにも印を付けない', () => {
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(8) }, {}, vi.fn());
    expect(cardOf(1)?.dataset.qtgAiDim).toBeUndefined();
  });

  it('オンなら強調される記事のカードだけに印を付ける', () => {
    // Arrange
    document.body.innerHTML = card(1) + card(2);
    const hints: AiHintLog = {
      [itemIdOf(1)]: hint(AI_HINT_DEFAULT_THRESHOLD),
      [itemIdOf(2)]: hint(AI_HINT_DEFAULT_THRESHOLD - 1),
    };
    // Act
    renderAiHints(hints, {}, vi.fn(), dimOn);
    // Assert
    expect(cardOf(1)?.dataset.qtgAiDim).toBe('true');
    expect(cardOf(2)?.dataset.qtgAiDim).toBeUndefined();
  });

  it('印はカードに付け、ヒント自体には付けない（ヒントと回答ボタンは薄くしない）', () => {
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(8) }, {}, vi.fn(), dimOn);
    expect(hintsOn(1)?.dataset.qtgAiDim).toBeUndefined();
    expect(buttonOf(1, 'そうかも')).toBeDefined();
  });

  it('線引きを上げて描き直すと印が外れる', () => {
    document.body.innerHTML = card(1);
    const hints: AiHintLog = { [itemIdOf(1)]: hint(5) };
    renderAiHints(hints, {}, vi.fn(), dimOn);
    renderAiHints(hints, {}, vi.fn(), { ...dimOn, threshold: 6 });
    expect(cardOf(1)?.dataset.qtgAiDim).toBeUndefined();
  });

  it('オフに戻して描き直すと印が外れる', () => {
    document.body.innerHTML = card(1);
    const hints: AiHintLog = { [itemIdOf(1)]: hint(8) };
    renderAiHints(hints, {}, vi.fn(), dimOn);
    renderAiHints(hints, {}, vi.fn());
    expect(cardOf(1)?.dataset.qtgAiDim).toBeUndefined();
  });

  it('規則は、ヒント以外を薄くし、乗せた時・フォーカス時に戻す', () => {
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(8) }, {}, vi.fn(), dimOn);
    const rules = document.getElementById(AI_HINT_STYLE_ID)?.textContent ?? '';
    expect(rules).toContain('[data-qtg-ai-dim="true"] > :not([data-qtg-ai-hint])');
    expect(rules).toContain('[data-qtg-ai-dim="true"]:hover > :not([data-qtg-ai-hint])');
    expect(rules).toContain('[data-qtg-ai-dim="true"]:focus-within > :not([data-qtg-ai-hint])');
  });
});

describe('isOwnMutation', () => {
  // 同期で取り出す。マイクロタスクを挟むとコールバックに渡って空になる
  function recordsOf(mutate: () => void): MutationRecord[] {
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, { childList: true, subtree: true });
    mutate();
    const records = observer.takeRecords();
    observer.disconnect();
    return records;
  }

  it('表示を足した・描き直した変化は自分のもの', () => {
    // Arrange
    document.body.innerHTML = card(1);
    const hints: AiHintLog = { [itemIdOf(1)]: hint(5) };
    // Act
    const records = recordsOf(() => {
      renderAiHints(hints, {}, vi.fn());
      renderAiHints(hints, { [itemIdOf(1)]: answerOf('yes') }, vi.fn());
    });
    // Assert
    expect(records.length).toBeGreaterThan(0);
    expect(records.every(isOwnMutation)).toBe(true);
  });

  it('Qiita がカードを作り直した変化は自分のものではない', () => {
    document.body.innerHTML = card(1);
    const records = recordsOf(() => {
      document.body.innerHTML = card(1);
    });
    expect(records.some((record) => !isOwnMutation(record))).toBe(true);
  });
});

describe('clearAiHints', () => {
  it('拡張が足した表示だけを消す', () => {
    // Arrange
    document.body.innerHTML = card(1) + card(2);
    renderAiHints({ [itemIdOf(1)]: hint(5), [itemIdOf(2)]: hint(1) }, {}, vi.fn());
    // Act
    const removed = clearAiHints();
    // Assert
    expect(removed).toBe(2);
    expect(document.querySelectorAll('[data-qtg-ai-hint]')).toHaveLength(0);
    expect(document.querySelectorAll('.card')).toHaveLength(2);
  });

  it('右上に置くために変えたカードの position を元に戻す', () => {
    // Arrange
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(5) }, {}, vi.fn());
    // Act
    clearAiHints();
    // Assert
    expect(document.querySelector<HTMLElement>('.card')?.style.position).toBe('');
  });

  it('入れたスタイルも消す', () => {
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(5) }, {}, vi.fn());
    clearAiHints();
    expect(document.getElementById(AI_HINT_STYLE_ID)).toBeNull();
  });

  it('カードに付けた目印も消す', () => {
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(1) }, {}, vi.fn());
    clearAiHints();
    expect(document.querySelector<HTMLElement>('.card')?.dataset.qtgAiCard).toBeUndefined();
  });

  it('薄く表示する印も消す', () => {
    document.body.innerHTML = card(1);
    renderAiHints({ [itemIdOf(1)]: hint(8) }, {}, vi.fn(), {
      ...DEFAULT_AI_HINT_PREFS,
      dimLikely: true,
    });
    clearAiHints();
    expect(document.querySelector<HTMLElement>('.card')?.dataset.qtgAiDim).toBeUndefined();
  });
});
