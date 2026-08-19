import { describe, it, expect } from 'vitest';
import { parseFeed, parseEntry } from './atom-parser';

/**
 * フィクスチャはすべて合成値。実アカウント名・実 item_id は使わない
 * （CLAUDE.md の記事化制約。リポジトリに実データを持ち込まない）。
 * 構造だけ 2026-08-19 の実測に合わせている。
 */
function buildEntry(index: number, overrides: { omitLink?: boolean } = {}): string {
  const handle = `example-author-${index}`;
  const itemId = `0123456789abcdef${String(index).padStart(4, '0')}`;
  // 実データの href には UTM パラメータが付く（& は XML エスケープされる）。
  // これを模さないと、実際には全件落ちるのにテストが通ってしまう。
  const utm = '?utm_campaign=popular_items&amp;utm_medium=feed&amp;utm_source=popular_items';
  const link = overrides.omitLink
    ? ''
    : `<link rel="alternate" type="text/html" href="https://qiita.com/${handle}/items/${itemId}${utm}"/>`;
  return `  <entry>
    <id>tag:qiita.com,2005:PublicArticle/${1000000 + index}</id>
    <published>2026-08-1${index % 10}T11:59:04+09:00</published>
    <updated>2026-08-1${index % 10}T12:00:00+09:00</updated>
    ${link}
    <title>サンプル記事 ${index}</title>
    <content type="text">本文の抜粋…</content>
    <author>
      <name>${handle}</name>
    </author>
  </entry>`;
}

function buildFeed(entries: string[], feedUpdated = '2026-08-19T05:00:00+09:00'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="ja-JP" xmlns="http://www.w3.org/2005/Atom">
  <id>tag:qiita.com,2005:/popular-items/feed</id>
  <link rel="alternate" type="text/html" href="https://qiita.com/popular-items"/>
  <link rel="self" type="application/atom+xml" href="https://qiita.com/popular-items/feed"/>
  <title>Qiita - 人気の記事</title>
  <updated>${feedUpdated}</updated>
${entries.join('\n')}
</feed>`;
}

describe('parseFeed', () => {
  it('ルートの updated を取る（entry の updated と取り違えない）', () => {
    // Arrange — entry 側は 2026-08-1X、ルートは 2026-08-19T05:00:00
    const xml = buildFeed([buildEntry(1), buildEntry(2)]);
    // Act
    const snapshot = parseFeed(xml);
    // Assert
    expect(snapshot?.feedUpdated).toBe('2026-08-19T05:00:00+09:00');
  });

  it('item_id を link の URL から取る（<id> の数値を使わない）', () => {
    // Arrange
    const xml = buildFeed([buildEntry(1)]);
    // Act
    const snapshot = parseFeed(xml);
    // Assert
    const item = snapshot?.items[0];
    expect(item?.itemId).toBe('0123456789abcdef0001');
    expect(item?.itemId).not.toContain('PublicArticle');
    expect(item?.itemId).not.toBe('1000001');
  });

  it('著者ハンドルを link の URL から取る', () => {
    const snapshot = parseFeed(buildFeed([buildEntry(3)]));
    expect(snapshot?.items[0]?.authorHandle).toBe('example-author-3');
  });

  it('published を取る', () => {
    const snapshot = parseFeed(buildFeed([buildEntry(4)]));
    expect(snapshot?.items[0]?.publishedAt).toBe('2026-08-14T11:59:04+09:00');
  });

  it('entry が 30 件なら 30 件返す', () => {
    // Arrange
    const entries = Array.from({ length: 30 }, (_, i) => buildEntry(i));
    // Act
    const snapshot = parseFeed(buildFeed(entries));
    // Assert
    expect(snapshot?.items).toHaveLength(30);
  });

  it('link が欠けた entry だけを捨て、残りは返す', () => {
    // Arrange — 30 件中 1 件だけ link を落とす
    const entries = Array.from({ length: 30 }, (_, i) =>
      i === 7 ? buildEntry(i, { omitLink: true }) : buildEntry(i),
    );
    // Act
    const snapshot = parseFeed(buildFeed(entries));
    // Assert
    expect(snapshot?.items).toHaveLength(29);
    expect(snapshot?.items.map((item) => item.authorHandle)).not.toContain('example-author-7');
  });

  it('entry が 0 件でも feedUpdated を返す', () => {
    const snapshot = parseFeed(buildFeed([]));
    expect(snapshot?.feedUpdated).toBe('2026-08-19T05:00:00+09:00');
    expect(snapshot?.items).toEqual([]);
  });

  it('空文字なら null を返し例外を投げない', () => {
    expect(() => parseFeed('')).not.toThrow();
    expect(parseFeed('')).toBeNull();
  });

  it('不正な XML なら null を返す', () => {
    expect(parseFeed('<not-xml')).toBeNull();
  });

  it('ルートの updated が無ければ null を返す', () => {
    const xml = `<feed><title>no updated</title>${buildEntry(1)}</feed>`;
    expect(parseFeed(xml)).toBeNull();
  });
});

describe('parseEntry', () => {
  it('link が無ければ null', () => {
    expect(parseEntry(buildEntry(1, { omitLink: true }))).toBeNull();
  });

  it('published が無ければ null', () => {
    const xml = `<entry><link rel="alternate" type="text/html"
      href="https://qiita.com/example-author/items/0123456789abcdef0123"/></entry>`;
    expect(parseEntry(xml)).toBeNull();
  });

  it('url は UTM パラメータを除いた正規化 URL になる', () => {
    const item = parseEntry(buildEntry(5));
    expect(item?.url).toBe('https://qiita.com/example-author-5/items/0123456789abcdef0005');
    expect(item?.url).not.toContain('utm_');
  });

  it('handle にパス階層を書き換える値が入った entry は落とす', () => {
    // Arrange — .. が通ると /users/../items が別エンドポイントになる
    const xml = `<entry><published>2026-08-18T10:00:00+09:00</published>
      <link rel="alternate" type="text/html"
        href="https://qiita.com/../items/0123456789abcdef0123"/></entry>`;
    // Act & Assert
    expect(parseEntry(xml)).toBeNull();
  });

  it('handle にクエリ記号が入った entry は落とす', () => {
    const xml = `<entry><published>2026-08-18T10:00:00+09:00</published>
      <link rel="alternate" type="text/html"
        href="https://qiita.com/foo?x=1/items/0123456789abcdef0123"/></entry>`;
    expect(parseEntry(xml)).toBeNull();
  });

  it('item_id に想定外の文字が入った entry は落とす', () => {
    const xml = `<entry><published>2026-08-18T10:00:00+09:00</published>
      <link rel="alternate" type="text/html"
        href="https://qiita.com/example-author/items/..%2Fadmin"/></entry>`;
    expect(parseEntry(xml)).toBeNull();
  });

  it('UTM が付いていない href でも item_id を取れる', () => {
    // Arrange — Qiita が UTM を外した場合への備え
    const xml = `<entry><published>2026-08-18T10:00:00+09:00</published>
      <link rel="alternate" type="text/html"
        href="https://qiita.com/example-author/items/0123456789abcdef0123"/></entry>`;
    // Act & Assert
    expect(parseEntry(xml)?.itemId).toBe('0123456789abcdef0123');
  });
});
