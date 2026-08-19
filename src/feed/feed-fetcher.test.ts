import { describe, it, expect, vi } from 'vitest';
import { fetchFeedIfChanged, FEED_URL } from './feed-fetcher';
import { saveFeedCache } from '../lib/storage';
import { QtgError } from '../lib/errors';

/** 合成フィード。実データは使わない */
function feedXml(feedUpdated: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <updated>${feedUpdated}</updated>
  <entry>
    <published>2026-08-18T10:00:00+09:00</published>
    <link rel="alternate" type="text/html"
          href="https://qiita.com/example-author/items/0123456789abcdef0123"/>
  </entry>
</feed>`;
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function requestHeaders(mock: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = mock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers ?? {};
}

describe('fetchFeedIfChanged', () => {
  it('ETag 未保存なら If-None-Match を付けない', async () => {
    // Arrange
    const mock = stubFetch(new Response(feedXml('2026-08-19T05:00:00+09:00'), { status: 200 }));
    // Act
    await fetchFeedIfChanged();
    // Assert
    expect(mock.mock.calls[0]?.[0]).toBe(FEED_URL);
    expect(requestHeaders(mock)).not.toHaveProperty('If-None-Match');
  });

  it('ETag 保存済みなら If-None-Match をそのまま送る', async () => {
    // Arrange
    await saveFeedCache('W/"0123456789abcdef"', '2026-08-18T17:00:00+09:00');
    const mock = stubFetch(new Response(feedXml('2026-08-19T05:00:00+09:00'), { status: 200 }));
    // Act
    await fetchFeedIfChanged();
    // Assert
    expect(requestHeaders(mock)['If-None-Match']).toBe('W/"0123456789abcdef"');
  });

  it('304 なら unchanged を返す', async () => {
    // Arrange
    await saveFeedCache('W/"0123456789abcdef"', '2026-08-18T17:00:00+09:00');
    stubFetch(new Response(null, { status: 304 }));
    // Act
    const outcome = await fetchFeedIfChanged();
    // Assert
    expect(outcome).toEqual({ kind: 'unchanged' });
  });

  it('200 でも updated が前回と同じなら unchanged', async () => {
    await saveFeedCache(null, '2026-08-19T05:00:00+09:00');
    stubFetch(new Response(feedXml('2026-08-19T05:00:00+09:00'), { status: 200 }));
    const outcome = await fetchFeedIfChanged();
    expect(outcome.kind).toBe('unchanged');
  });

  it('updated が変化したら snapshot と ETag を返す', async () => {
    // Arrange
    await saveFeedCache(null, '2026-08-18T17:00:00+09:00');
    stubFetch(
      new Response(feedXml('2026-08-19T05:00:00+09:00'), {
        status: 200,
        headers: { ETag: 'W/"fedcba9876543210"' },
      }),
    );
    // Act
    const outcome = await fetchFeedIfChanged();
    // Assert
    expect(outcome.kind).toBe('updated');
    if (outcome.kind !== 'updated') return;
    expect(outcome.snapshot.feedUpdated).toBe('2026-08-19T05:00:00+09:00');
    expect(outcome.snapshot.items).toHaveLength(1);
    expect(outcome.etag).toBe('W/"fedcba9876543210"');
  });

  it('fetch が失敗したら QtgError を投げる', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));
    await expect(fetchFeedIfChanged()).rejects.toThrow(QtgError);
  });

  it('5xx なら QtgError を投げる', async () => {
    stubFetch(new Response('', { status: 503 }));
    await expect(fetchFeedIfChanged()).rejects.toThrow(QtgError);
  });

  it('パースできない本文なら QtgError を投げる', async () => {
    stubFetch(new Response('<not-xml', { status: 200 }));
    await expect(fetchFeedIfChanged()).rejects.toThrow(QtgError);
  });
});
