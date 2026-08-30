import { describe, it, expect, vi } from 'vitest';
import { fetchLikes, fetchUserItems, verifyToken } from './qiita-client';
import { QtgError, RateLimitError } from '../lib/errors';
import { logger } from '../lib/logger';

// Chrome は console.warn も chrome://extensions のエラー欄に集めるため、
// 想定内の失敗でレベルが上がっていないことを検証する
vi.mock('../lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** 合成の liker。実アカウント名は使わない */
function like(handle: string, itemsCount = 0): unknown {
  return {
    created_at: '2026-08-19T06:00:00+09:00',
    user: {
      id: handle,
      items_count: itemsCount,
      followers_count: 1,
      description: null,
    },
  };
}

function stubFetch(body: unknown, init: ResponseInit = { status: 200 }): ReturnType<typeof vi.fn> {
  const mock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), init)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function headersOf(mock: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = mock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers ?? {};
}

describe('fetchLikes', () => {
  it('トークンが null なら Authorization を付けない', async () => {
    // Arrange
    const mock = stubFetch([like('example-liker')]);
    // Act
    await fetchLikes('0123456789abcdef0123', null);
    // Assert
    expect(headersOf(mock)).not.toHaveProperty('Authorization');
  });

  it('トークンがあれば Bearer を付ける', async () => {
    const mock = stubFetch([like('example-liker')]);
    await fetchLikes('0123456789abcdef0123', 'dummy-token-value');
    expect(headersOf(mock).Authorization).toBe('Bearer dummy-token-value');
  });

  it('per_page=100 を付けて item_id をパスに入れる', async () => {
    const mock = stubFetch([]);
    await fetchLikes('0123456789abcdef0123', null);
    expect(mock.mock.calls[0]?.[0]).toBe(
      'https://qiita.com/api/v2/items/0123456789abcdef0123/likes?per_page=100&page=1',
    );
  });

  it('正常な配列を data として返す', async () => {
    stubFetch([like('example-liker-1'), like('example-liker-2')]);
    const result = await fetchLikes('0123456789abcdef0123', null);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]?.user.id).toBe('example-liker-1');
  });

  it('user が欠けた要素だけ落として他は返す', async () => {
    // Arrange — 3 件中 1 件が壊れている
    stubFetch([
      like('example-liker-1'),
      { created_at: '2026-08-19T06:00:00+09:00' },
      like('example-liker-2'),
    ]);
    // Act
    const result = await fetchLikes('0123456789abcdef0123', null);
    // Assert
    expect(result.data).toHaveLength(2);
  });

  it('Rate-* と Total-Count をヘッダーから読む', async () => {
    stubFetch([like('example-liker')], {
      status: 200,
      headers: { 'Rate-Limit': '60', 'Rate-Remaining': '59', 'Total-Count': '18' },
    });
    const result = await fetchLikes('0123456789abcdef0123', null);
    expect(result.rate).toEqual({ limit: 60, remaining: 59, resetAt: null });
    expect(result.totalCount).toBe(18);
  });

  it('401 なら QtgError を投げる', async () => {
    stubFetch({ message: 'Unauthorized' }, { status: 401 });
    await expect(fetchLikes('0123456789abcdef0123', 'bad')).rejects.toThrow(QtgError);
  });

  it('429 なら RateLimitError を投げ、Rate-Reset を載せる', async () => {
    // Arrange — 呼び出し側は「読み飛ばして続行」と「そこで止める」を
    // 区別する必要がある。message の文字列一致で見分けるのは脆い
    stubFetch(
      { message: 'Rate limit exceeded' },
      {
        status: 429,
        headers: { 'Rate-Limit': '60', 'Rate-Remaining': '0', 'Rate-Reset': '1787104432' },
      },
    );
    // Act
    const error = await fetchLikes('0123456789abcdef0123', null).catch((e: unknown) => e);
    // Assert
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toBeInstanceOf(QtgError);
    expect((error as RateLimitError).resetAt).toBe(1787104432);
  });

  it('Rate-Reset の無い 429 でも RateLimitError を投げる（resetAt は null）', async () => {
    stubFetch({ message: 'Rate limit exceeded' }, { status: 429 });
    const error = await fetchLikes('0123456789abcdef0123', null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).resetAt).toBeNull();
  });

  it('配列でない応答なら QtgError を投げる', async () => {
    stubFetch({ message: 'not an array' });
    await expect(fetchLikes('0123456789abcdef0123', null)).rejects.toThrow(QtgError);
  });

  it('ネットワーク失敗なら QtgError を投げる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    await expect(fetchLikes('0123456789abcdef0123', null)).rejects.toThrow(QtgError);
  });
});

describe('パスセグメントの検証', () => {
  it('item_id に .. が入ったら fetch せず QtgError を投げる', async () => {
    // Arrange — encodeURIComponent は "." を素通しするので、検証で止める必要がある
    const mock = stubFetch([]);
    // Act & Assert
    await expect(fetchLikes('../../admin', null)).rejects.toThrow(QtgError);
    expect(mock).not.toHaveBeenCalled();
  });

  it('handle に .. が入ったら fetch せず QtgError を投げる', async () => {
    const mock = stubFetch([]);
    await expect(fetchUserItems('..', null)).rejects.toThrow(QtgError);
    expect(mock).not.toHaveBeenCalled();
  });

  it('handle にクエリ記号が入ったら QtgError を投げる', async () => {
    stubFetch([]);
    await expect(fetchUserItems('foo?x=1', null)).rejects.toThrow(QtgError);
  });

  it('空文字は通さない', async () => {
    stubFetch([]);
    await expect(fetchLikes('', null)).rejects.toThrow(QtgError);
  });

  it('英数・ハイフン・アンダースコアは通す', async () => {
    const mock = stubFetch([]);
    await fetchUserItems('example_author-1', null);
    expect(mock.mock.calls[0]?.[0]).toContain('/users/example_author-1/items');
  });
});

describe('fetchUserItems', () => {
  it('著者ハンドルをパスに入れる', async () => {
    const mock = stubFetch([
      { id: '0123456789abcdef0123', created_at: '2026-08-18T10:00:00+09:00' },
    ]);
    const result = await fetchUserItems('example-author', null);
    expect(mock.mock.calls[0]?.[0]).toBe(
      'https://qiita.com/api/v2/users/example-author/items?per_page=100',
    );
    expect(result.data[0]?.id).toBe('0123456789abcdef0123');
  });
});

describe('verifyToken', () => {
  it('200 なら ok を返す', async () => {
    // Arrange
    stubFetch({ id: 'example-user' });
    // Act & Assert
    await expect(verifyToken('dummy-token-value')).resolves.toEqual({ ok: true });
  });

  it('401 は invalid として返す（トークンが違う）', async () => {
    stubFetch({ message: 'Unauthorized' }, { status: 401 });
    await expect(verifyToken('bad-token')).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('403 も invalid として返す', async () => {
    stubFetch({ message: 'Forbidden' }, { status: 403 });
    await expect(verifyToken('bad-token')).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('通信失敗は network として返す（トークンのせいにしない）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    await expect(verifyToken('dummy-token-value')).resolves.toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('500 は network として返す（サーバー側の問題）', async () => {
    stubFetch({ message: 'Internal Server Error' }, { status: 500 });
    await expect(verifyToken('dummy-token-value')).resolves.toEqual({
      ok: false,
      reason: 'network',
    });
  });
});

describe('ログの扱い', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it('401 では warn も error も出さない（拡張の不具合として記録させない）', async () => {
    // Arrange — ユーザーがトークンを打ち間違えただけ。UI が伝えるので十分
    stubFetch({ message: 'Unauthorized' }, { status: 401 });
    // Act
    await expect(fetchLikes('0123456789abcdef0123', 'bad')).rejects.toThrow(QtgError);
    // Assert
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });

  it('403 でも warn も error も出さない', async () => {
    stubFetch({ message: 'Forbidden' }, { status: 403 });
    await expect(fetchLikes('0123456789abcdef0123', 'bad')).rejects.toThrow(QtgError);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });

  it('429 でも warn も error も出さない（設計どおりの停止信号）', async () => {
    // Arrange — ライトモードの枠は 60 req/h。トレンド 30 件を 2 回読めば届く。
    // 正常な無料プランの挙動がエラー欄に記録されるのは設計の失敗（改訂 6）
    stubFetch({ message: 'Rate limit exceeded' }, { status: 429 });
    // Act
    await expect(fetchLikes('0123456789abcdef0123', null)).rejects.toThrow(RateLimitError);
    // Assert
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });

  it('どのログにもトークンを渡さない', async () => {
    stubFetch({ message: 'Unauthorized' }, { status: 401 });
    await expect(fetchLikes('0123456789abcdef0123', 'dummy-token-value')).rejects.toThrow();
    const calls = [
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ].flat();
    expect(calls.some((arg) => String(arg).includes('dummy-token-value'))).toBe(false);
  });
});
