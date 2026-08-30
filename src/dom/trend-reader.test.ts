import { describe, it, expect } from 'vitest';
import { readTrendItems, isTrendPage } from './trend-reader';

/**
 * 1 カード分の骨格。実測どおり **記事リンクを 2 本** 持たせる
 * （タイトル無しとタイトル付き）。1 本にすると重複排除のテストが成立しない。
 *
 * フィクスチャは合成値のみ。実アカウント名・実 item_id は使わない。
 */
function card(n: number, opts: { time?: string | null; url?: string } = {}): string {
  const handle = `example-author-${String(n)}`;
  const itemId = `0123456789abcdef${String(n).padStart(4, '0')}`;
  const url = opts.url ?? `https://qiita.com/${handle}/items/${itemId}`;
  const time =
    opts.time === null
      ? ''
      : `<time datetime="${opts.time ?? '2026-08-18T10:00:00Z'}">2026年08月18日</time>`;
  return `<div><a href="${url}"></a>${time}<a href="${url}">タイトル ${String(n)}</a></div>`;
}

function cards(count: number): string {
  return Array.from({ length: count }, (_, i) => card(i + 1)).join('');
}

describe('readTrendItems', () => {
  it('トレンド 30 件を 30 件として返す（60 リンクを畳む）', () => {
    // Arrange — 実測は links: 60 / 記事 30 件
    document.body.innerHTML = cards(30);
    // Act
    const items = readTrendItems();
    // Assert
    expect(items).toHaveLength(30);
  });

  it('同じ記事の 2 本のリンクを 1 件に畳む', () => {
    // Arrange — 1 カードに 2 本ある（タイトル付きと無し）
    document.body.innerHTML = card(1);
    expect(document.querySelectorAll('a[href*="/items/"]')).toHaveLength(2);
    // Act & Assert — 畳まないと 2 倍に膨らむ
    expect(readTrendItems()).toHaveLength(1);
  });

  it('URL から handle と itemId を取り出す', () => {
    // Arrange
    document.body.innerHTML = card(7);
    // Act
    const [item] = readTrendItems();
    // Assert
    expect(item).toEqual({
      itemId: '0123456789abcdef0007',
      url: 'https://qiita.com/example-author-7/items/0123456789abcdef0007',
      authorHandle: 'example-author-7',
      publishedAt: '2026-08-18T10:00:00Z',
    });
  });

  it('表示テキストではなく datetime 属性を投稿時刻にする', () => {
    // Arrange — 表示は「2026年08月18日」だが実体は UTC で前日 17:44
    document.body.innerHTML = card(1, { time: '2026-08-17T17:44:41Z' });
    // Act
    const [item] = readTrendItems();
    // Assert — textContent を読むと JST 表示との日付ずれを取り込む
    expect(item?.publishedAt).toBe('2026-08-17T17:44:41Z');
  });

  it('クエリ付きの URL でも正規化した URL を返す', () => {
    // Arrange — 共有リンク経由だと UTM が付く
    const url = 'https://qiita.com/example-author-1/items/0123456789abcdef0001?utm_source=x#c1';
    document.body.innerHTML = card(1, { url });
    // Act
    const [item] = readTrendItems();
    // Assert — クエリ違いで同じ記事を二重に数えない
    expect(item?.url).toBe('https://qiita.com/example-author-1/items/0123456789abcdef0001');
    expect(item?.itemId).toBe('0123456789abcdef0001');
  });
});

/**
 * 取れなかったものは捨てる（設計上の約束 3）。
 * 誤った対象を操作するより、何もしない方が無害。
 */
describe('readTrendItems のフェイルセーフ', () => {
  it('time が無いカードは捨て、他のカードは残す', () => {
    // Arrange
    document.body.innerHTML = card(1, { time: null }) + card(2);
    // Act
    const items = readTrendItems();
    // Assert
    expect(items).toHaveLength(1);
    expect(items[0]?.authorHandle).toBe('example-author-2');
  });

  it('datetime が空のカードは捨てる', () => {
    document.body.innerHTML = card(1, { time: '' }) + card(2);
    expect(readTrendItems()).toHaveLength(1);
  });

  it('handle に .. を含む URL は捨てる', () => {
    // Arrange — ブラウザ側で正規化されたうえ、パターンにも一致しない
    document.body.innerHTML = card(1, { url: 'https://qiita.com/../items/0123456789abcdef' });
    // Act & Assert — 通すと /users/../items が /api/items に潰れて別 API を叩く
    expect(readTrendItems()).toEqual([]);
  });

  it('handle に想定外の文字を含む URL は捨てる', () => {
    document.body.innerHTML = card(1, {
      url: 'https://qiita.com/ex%2Fample/items/0123456789abcdef',
    });
    expect(readTrendItems()).toEqual([]);
  });

  it('itemId に想定外の文字を含む URL は捨てる', () => {
    document.body.innerHTML = card(1, {
      url: 'https://qiita.com/example-author-1/items/..%2Fadmin',
    });
    expect(readTrendItems()).toEqual([]);
  });

  it('qiita.com 以外のリンクは捨てる', () => {
    document.body.innerHTML = card(1, {
      url: 'https://example.com/example-author-1/items/0123456789abcdef',
    });
    expect(readTrendItems()).toEqual([]);
  });

  it('記事リンクの無いページでは空配列を返し、例外を投げない', () => {
    document.body.innerHTML =
      '<div><a href="https://qiita.com/example-author-1">プロフィール</a></div>';
    expect(() => readTrendItems()).not.toThrow();
    expect(readTrendItems()).toEqual([]);
  });

  it('空の DOM でも空配列を返す', () => {
    document.body.innerHTML = '';
    expect(readTrendItems()).toEqual([]);
  });
});

/**
 * カード特定の核心。**別の記事の投稿時刻を取り違えないこと**を固定する。
 * 遡りすぎると必ずリンク数が LINKS_PER_CARD を超えるため null になる。
 */
describe('readTrendItems のカード特定', () => {
  it('カード外の time を自分の投稿時刻として拾わない', () => {
    // Arrange — card 1 に time が無く、兄弟の位置に別の time がある
    document.body.innerHTML = `<div>${card(1, { time: null })}${card(2)}<time datetime="2020-01-01T00:00:00Z">別物</time></div>`;
    // Act
    const items = readTrendItems();
    // Assert — card 1 は落ち、card 2 だけが残る
    expect(items).toHaveLength(1);
    expect(items[0]?.publishedAt).toBe('2026-08-18T10:00:00Z');
  });

  it('全カードを包む親に time があっても、個々のカードには使わない', () => {
    // Arrange — カード自身には time が無い
    document.body.innerHTML = `<div><time datetime="2020-01-01T00:00:00Z">全体</time>${card(1, { time: null })}${card(2, { time: null })}</div>`;
    // Act & Assert — 全カードが同じ時刻を持つとバースト判定が壊れる
    expect(readTrendItems()).toEqual([]);
  });

  it('カードが深すぎる位置にあれば諦める（MAX_CARD_DEPTH）', () => {
    // Arrange — リンクから 7 段上に time。無限に遡らせない
    const link = '<a href="https://qiita.com/example-author-1/items/0123456789abcdef0001"></a>';
    const deep = `<div><time datetime="2026-08-18T10:00:00Z">遠い</time><div><div><div><div><div><div><div>${link}</div></div></div></div></div></div></div>`;
    document.body.innerHTML = deep;
    // Act & Assert
    expect(readTrendItems()).toEqual([]);
  });

  it('リンクが 1 本だけのカードでも読める', () => {
    // Arrange — 2 本は実測値であって仕様ではない。1 本に減っても壊れないこと
    document.body.innerHTML =
      '<div><a href="https://qiita.com/example-author-1/items/0123456789abcdef0001">タイトル</a><time datetime="2026-08-18T10:00:00Z">2026年08月18日</time></div>';
    // Act & Assert
    expect(readTrendItems()).toHaveLength(1);
  });
});

/**
 * content script は qiita.com 全体に注入される。**プロフィールページには
 * その人の記事一覧があり、記事リンクと <time> が揃っている**ため、
 * ページを絞らないとトレンドでない記事に 60 req/h の枠を使う。
 */
describe('isTrendPage', () => {
  it('トップとトレンドは対象', () => {
    expect(isTrendPage('/')).toBe(true);
    expect(isTrendPage('/trend')).toBe(true);
  });

  it('末尾スラッシュがあっても対象', () => {
    expect(isTrendPage('/trend/')).toBe(true);
  });

  it('プロフィールページは対象外（記事一覧と time が揃っている）', () => {
    expect(isTrendPage('/example-author-1')).toBe(false);
  });

  it('記事ページは対象外', () => {
    expect(isTrendPage('/example-author-1/items/0123456789abcdef0001')).toBe(false);
  });

  it('タグページ・その他は対象外', () => {
    expect(isTrendPage('/tags/typescript')).toBe(false);
    expect(isTrendPage('/settings/applications')).toBe(false);
    expect(isTrendPage('/trending')).toBe(false);
  });
});
