import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  hideJudgedAuthors,
  unhideAll,
  countHidden,
  renderNotice,
  describeHidden,
  noticeAction,
} from './hider';
import { NOTICE_ID } from './selectors';
import type { FeedbackLog } from '../types/domain';

/**
 * 1 カード分の骨格。実測どおり **記事リンクを 2 本** 持たせる
 * （タイトル無しとタイトル付き）。1 本にすると二重処理のテストが成立しない。
 *
 * フィクスチャは合成値のみ。実アカウント名・実 item_id は使わない。
 */
function card(n: number, author = `example-author-${String(n)}`): string {
  const itemId = `0123456789abcdef${String(n).padStart(4, '0')}`;
  const url = `https://qiita.com/${author}/items/${itemId}`;
  return `<div class="card"><a href="${url}"></a><time datetime="2026-08-18T10:00:00Z">2026年08月18日</time><a href="${url}">タイトル ${String(n)}</a></div>`;
}

function setupCards(...html: string[]): void {
  document.body.innerHTML = html.join('');
}

/** 表示中のカード数（display が none でないもの） */
function visibleCards(): number {
  return [...document.querySelectorAll<HTMLElement>('.card')].filter(
    (el) => el.style.display !== 'none',
  ).length;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('hideJudgedAuthors', () => {
  it('妥当と評価された著者のカードを隠す', () => {
    // Arrange
    setupCards(card(1), card(2));
    const feedback: FeedbackLog = { 'example-author-1': 'valid' };
    // Act
    const result = hideJudgedAuthors(feedback);
    // Assert
    expect(result.hidden).toBe(1);
    expect(result.authors).toEqual(['example-author-1']);
    expect(visibleCards()).toBe(1);
  });

  it('誤りと評価された著者は隠さない', () => {
    // Arrange — 誤検知だったものを消してはいけない
    setupCards(card(1), card(2));
    const feedback: FeedbackLog = { 'example-author-1': 'false_positive' };
    // Act & Assert
    expect(hideJudgedAuthors(feedback).hidden).toBe(0);
    expect(visibleCards()).toBe(2);
  });

  it('未評価の著者は隠さない', () => {
    // Arrange — 適合率を測る前に対象が消えてはいけない
    setupCards(card(1), card(2));
    // Act & Assert
    expect(hideJudgedAuthors({}).hidden).toBe(0);
    expect(visibleCards()).toBe(2);
  });

  it('同じ著者の記事が複数あれば全部隠す', () => {
    // Arrange — 1 人が 2 本トレンドに出るのは常態（実測で 5 著者が 30 枠中 13）
    setupCards(card(1, 'example-author-a'), card(2, 'example-author-a'), card(3));
    // Act
    const result = hideJudgedAuthors({ 'example-author-a': 'valid' });
    // Assert
    expect(result.hidden).toBe(2);
    expect(result.authors).toEqual(['example-author-a']);
  });

  it('二重に隠さない（1 カードに記事リンクが 2 本ある）', () => {
    // Arrange
    setupCards(card(1));
    const feedback: FeedbackLog = { 'example-author-1': 'valid' };
    hideJudgedAuthors(feedback);
    // Act — 同じページで 2 回目
    const second = hideJudgedAuthors(feedback);
    // Assert — 件数が二重に数えられない
    expect(second.hidden).toBe(0);
    expect(countHidden()).toBe(1);
  });

  it('カードが特定できなければ何もしない（例外を投げない）', () => {
    // Arrange — <time> が無いので findCard が null を返す
    const url = 'https://qiita.com/example-author-1/items/0123456789abcdef0001';
    document.body.innerHTML = `<div class="card"><a href="${url}">タイトル</a></div>`;
    // Act & Assert — 誤った対象を隠すより何もしない（設計上の約束 3）
    expect(() => hideJudgedAuthors({ 'example-author-1': 'valid' })).not.toThrow();
    expect(countHidden()).toBe(0);
  });

  it('空の DOM でも例外を投げない', () => {
    expect(() => hideJudgedAuthors({ 'example-author-1': 'valid' })).not.toThrow();
    expect(hideJudgedAuthors({ 'example-author-1': 'valid' }).hidden).toBe(0);
  });

  it('隠したカードに目印を付ける', () => {
    // Arrange & Act
    setupCards(card(1));
    hideJudgedAuthors({ 'example-author-1': 'valid' });
    // Assert — 戻すときに「拡張が隠したものだけ」を選ぶために要る
    expect(document.querySelector('[data-qtg-hidden="true"]')).not.toBeNull();
  });
});

describe('unhideAll', () => {
  it('拡張が隠したものを戻す', () => {
    // Arrange
    setupCards(card(1), card(2));
    hideJudgedAuthors({ 'example-author-1': 'valid' });
    // Act
    const restored = unhideAll();
    // Assert
    expect(restored).toBe(1);
    expect(visibleCards()).toBe(2);
    expect(countHidden()).toBe(0);
  });

  it('Qiita 自身が隠している要素は触らない', () => {
    // Arrange — 拡張の目印が無い display:none
    document.body.innerHTML = '<div class="other" style="display:none">Qiita 側の非表示</div>';
    // Act
    unhideAll();
    // Assert — 目印を見ずに全部戻すと、Qiita の UI が壊れる
    const other = document.querySelector<HTMLElement>('.other');
    expect(other?.style.display).toBe('none');
  });

  it('隠すものが無ければ 0 を返す', () => {
    setupCards(card(1));
    expect(unhideAll()).toBe(0);
  });

  it('戻したあとは再び隠せる', () => {
    // Arrange
    setupCards(card(1));
    const feedback: FeedbackLog = { 'example-author-1': 'valid' };
    hideJudgedAuthors(feedback);
    unhideAll();
    // Act & Assert — 目印を消していないと 2 回目が効かない
    expect(hideJudgedAuthors(feedback).hidden).toBe(1);
  });
});

describe('countHidden', () => {
  it('隠している件数を数える', () => {
    setupCards(card(1, 'example-author-a'), card(2, 'example-author-a'), card(3));
    hideJudgedAuthors({ 'example-author-a': 'valid' });
    expect(countHidden()).toBe(2);
  });

  it('何も隠していなければ 0', () => {
    setupCards(card(1));
    expect(countHidden()).toBe(0);
  });
});

describe('renderNotice', () => {
  const noop = (): void => undefined;

  it('0 件なら要素を作らない', () => {
    // Arrange & Act — 空の枠だけが右下に残ると邪魔になる
    renderNotice(0, noop);
    // Assert
    expect(document.querySelector(`#${NOTICE_ID}`)).toBeNull();
  });

  it('1 件以上なら件数と戻すボタンを出す', () => {
    // Act
    renderNotice(2, noop);
    // Assert
    const notice = document.querySelector<HTMLElement>(`#${NOTICE_ID}`);
    expect(notice?.textContent).toContain('2 件を非表示中');
    expect(notice?.querySelector('button')?.textContent).toBe('表示する');
  });

  it('件数が変わったら要素を作り直さず書き換える', () => {
    // Arrange
    renderNotice(1, noop);
    const first = document.querySelector(`#${NOTICE_ID}`);
    // Act
    renderNotice(3, noop);
    // Assert — 作り直すとボタンを押す瞬間に要素が差し替わる
    const second = document.querySelector(`#${NOTICE_ID}`);
    expect(second).toBe(first);
    expect(second?.textContent).toContain('3 件を非表示中');
  });

  it('0 件になったら消す', () => {
    renderNotice(2, noop);
    renderNotice(0, noop);
    expect(document.querySelector(`#${NOTICE_ID}`)).toBeNull();
  });

  it('ボタンを押すとコールバックが走る', () => {
    // Arrange
    const onUnhide = vi.fn();
    renderNotice(1, onUnhide);
    // Act
    document.querySelector<HTMLButtonElement>(`#${NOTICE_ID} button`)?.click();
    // Assert
    expect(onUnhide).toHaveBeenCalledTimes(1);
  });

  it('文言で断定しない（設計上の約束 6）', () => {
    // 「ブロック」「不正」「スパム」とは書かない
    expect(describeHidden(3)).toBe('3 件を非表示中');
    expect(describeHidden(3)).not.toMatch(/ブロック|不正|スパム/);
  });
});

/**
 * findCard が null を返したときに何もしないことを直接守る。
 *
 * 「カードが特定できなければ何もしない」だけでは足りない。**readTrendItems が
 * 0 件を返して早期 return するので、ループにすら入っていなかった。**
 * 落ちない理由を確かめるまで、テストが何を守っているかは分からない。
 */
describe('hideJudgedAuthors の カード特定失敗', () => {
  it('カードが取れないリンクは触らない（隠す対象の著者でも）', () => {
    // Arrange — 正しいカードが 1 枚あるので readTrendItems は著者を読む。
    // そのうえで、カードの外に同じ記事へのリンクを置く（<time> が無い）
    const url = 'https://qiita.com/example-author-1/items/0123456789abcdef0001';
    document.body.innerHTML =
      `<div class="card"><a href="${url}"></a><time datetime="2026-08-18T10:00:00Z">2026年08月18日</time><a href="${url}">タイトル</a></div>` +
      `<p class="stray"><a href="${url}">関連記事</a></p>`;
    // Act
    hideJudgedAuthors({ 'example-author-1': 'valid' });
    // Assert — findCard が null のとき link 自体を隠すと、
    // 記事一覧と無関係な場所のリンクまで消える
    const stray = document.querySelector<HTMLElement>('.stray a');
    expect(stray?.style.display).not.toBe('none');
    // カード本体は隠れている
    expect(countHidden()).toBe(1);
  });
});

/**
 * 通知はトグル。**「表示する」だけでは戻す手段が無かった。**
 *
 * ユーザーは「妥当」を押し直そうとしたが、評価が既に valid なので
 * storage の値が変わらず、onChanged が発火しない（Chrome は値が実際に
 * 変わったときだけ発火する）。何も起きないように見えた。
 */
describe('renderNotice のトグル', () => {
  const noop = (): void => undefined;

  it('hidden なら「非表示中」と「表示する」', () => {
    renderNotice(2, noop, document, 'hidden');
    const notice = document.querySelector<HTMLElement>(`#${NOTICE_ID}`);
    expect(notice?.textContent).toContain('2 件を非表示中');
    expect(notice?.querySelector('button')?.textContent).toBe('表示する');
  });

  it('shown なら「表示中」と「隠す」', () => {
    renderNotice(2, noop, document, 'shown');
    const notice = document.querySelector<HTMLElement>(`#${NOTICE_ID}`);
    expect(notice?.textContent).toContain('2 件を表示中');
    expect(notice?.querySelector('button')?.textContent).toBe('隠す');
  });

  it('モードが変わったらボタンの文言も書き換える', () => {
    // Arrange — 要素を作り直さずに書き換える経路
    renderNotice(2, noop, document, 'hidden');
    const first = document.querySelector(`#${NOTICE_ID}`);
    // Act
    renderNotice(2, noop, document, 'shown');
    // Assert — ラベルだけ変えてボタンを放置すると、押す先が無くなる
    const second = document.querySelector<HTMLElement>(`#${NOTICE_ID}`);
    expect(second).toBe(first);
    expect(second?.querySelector('button')?.textContent).toBe('隠す');
  });

  it('既定は hidden（引数を省略しても壊れない）', () => {
    renderNotice(1, noop);
    expect(document.querySelector(`#${NOTICE_ID} button`)?.textContent).toBe('表示する');
  });

  it('文言はどちらのモードでも断定しない（約束 6）', () => {
    expect(describeHidden(2, 'shown')).toBe('2 件を表示中');
    expect(noticeAction('shown')).toBe('隠す');
    expect(describeHidden(2, 'shown')).not.toMatch(/ブロック|不正|スパム/);
  });
});
