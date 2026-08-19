import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runScan } from './scanner';
import { fetchFeedIfChanged } from '../feed/feed-fetcher';
import { fetchLikes, fetchUserItems } from '../api/qiita-client';
import { saveToken, getLikeIndex, getFeedCache } from '../lib/storage';

vi.mock('../feed/feed-fetcher', () => ({ fetchFeedIfChanged: vi.fn() }));
vi.mock('../api/qiita-client', () => ({ fetchLikes: vi.fn(), fetchUserItems: vi.fn() }));

const feedMock = vi.mocked(fetchFeedIfChanged);
const likesMock = vi.mocked(fetchLikes);
const itemsMock = vi.mocked(fetchUserItems);

function trendItem(index: number) {
  const handle = `example-author-${index}`;
  const itemId = `0123456789abcdef${String(index).padStart(4, '0')}`;
  return { itemId, url: `https://qiita.com/${handle}/items/${itemId}`, authorHandle: handle,
    publishedAt: '2026-08-18T10:00:00+09:00' };
}

function likeOf(handle: string) {
  return { created_at: '2026-08-19T06:00:00+09:00',
    user: { id: handle, items_count: 0, followers_count: 1, description: null } };
}

function likesResponse(handles: string[], remaining = 55) {
  return { data: handles.map(likeOf), totalCount: handles.length,
    rate: { limit: 60, remaining, resetAt: null } };
}

beforeEach(() => {
  vi.clearAllMocks();
  feedMock.mockResolvedValue({
    kind: 'updated',
    snapshot: { feedUpdated: '2026-08-19T05:00:00+09:00', items: [trendItem(1), trendItem(2)] },
    etag: 'W/"0123456789abcdef"',
  });
  likesMock.mockResolvedValue(likesResponse(['example-liker-a', 'example-liker-b']));
  itemsMock.mockResolvedValue({
    data: [{ id: 'fedcba9876543210fedc', created_at: '2026-08-10T09:00:00+09:00' }],
    totalCount: 1, rate: { limit: 1000, remaining: 990, resetAt: null },
  });
});

describe('runScan', () => {
  it('フィードが変わっていなければ null を返し API を叩かない', async () => {
    // Arrange
    feedMock.mockResolvedValue({ kind: 'unchanged' });
    // Act
    const result = await runScan();
    // Assert
    expect(result).toBeNull();
    expect(likesMock).not.toHaveBeenCalled();
  });

  it('ライトモードでは著者の過去記事を辿らない', async () => {
    // Arrange — トークン未設定
    // Act
    const result = await runScan();
    // Assert
    expect(result?.mode).toBe('light');
    expect(itemsMock).not.toHaveBeenCalled();
    expect(likesMock).toHaveBeenCalledTimes(2);
  });

  it('フルモードでは著者の過去記事も辿る', async () => {
    // Arrange
    await saveToken('dummy-token-value');
    // Act
    const result = await runScan();
    // Assert
    expect(result?.mode).toBe('full');
    expect(itemsMock).toHaveBeenCalledTimes(2);
  });

  it('likers をアカウント単位に畳んで保存する', async () => {
    // Act
    await runScan();
    // Assert
    const index = await getLikeIndex();
    expect(Object.keys(index).sort()).toEqual(['example-liker-a', 'example-liker-b']);
    expect(index['example-liker-a']?.likes).toHaveLength(2);
    expect(index['example-liker-a']?.likes[0]?.itemPostedAt).toBe('2026-08-18T10:00:00+09:00');
  });

  it('残り枠が余白を切ったら打ち切って truncated を立てる', async () => {
    // Arrange — 1 件目の応答で残量 3（余白 5 未満）
    likesMock.mockResolvedValueOnce(likesResponse(['example-liker-a'], 3));
    // Act
    const result = await runScan();
    // Assert
    expect(result?.truncated).toBe(true);
    expect(result?.scannedItemCount).toBe(1);
    expect(likesMock).toHaveBeenCalledTimes(1);
  });

  it('1 記事が失敗しても残りを処理する', async () => {
    // Arrange
    likesMock.mockRejectedValueOnce(new Error('boom'));
    // Act
    const result = await runScan();
    // Assert
    expect(result?.scannedItemCount).toBe(1);
    expect(likesMock).toHaveBeenCalledTimes(2);
  });

  it('完走したらフィードを処理済みとして保存する', async () => {
    // Act
    const result = await runScan();
    // Assert
    expect(result?.truncated).toBe(false);
    const cache = await getFeedCache();
    expect(cache.lastUpdated).toBe('2026-08-19T05:00:00+09:00');
    expect(cache.etag).toBe('W/"0123456789abcdef"');
  });

  it('打ち切ったらフィードを処理済みにしない（次回に再試行できる）', async () => {
    // Arrange — 1 件目の応答で残量 3（余白 5 未満）にして打ち切らせる
    likesMock.mockResolvedValueOnce(likesResponse(['example-liker-a'], 3));
    // Act
    const result = await runScan();
    // Assert — 保存すると次回が <updated> 不変でスキップされ、欠けたまま固定される
    expect(result?.truncated).toBe(true);
    const cache = await getFeedCache();
    expect(cache.lastUpdated).toBeNull();
    expect(cache.etag).toBeNull();
  });

  it('打ち切っても取得済みのインデックスは保存する', async () => {
    // Arrange
    likesMock.mockResolvedValueOnce(likesResponse(['example-liker-a'], 3));
    // Act
    await runScan();
    // Assert — 途中まででも成果は捨てない
    const index = await getLikeIndex();
    expect(Object.keys(index)).toEqual(['example-liker-a']);
  });

  it('スキャン結果に開始と終了の時刻が入る', async () => {
    const result = await runScan();
    expect(result?.startedAt).toBeTruthy();
    expect(result?.finishedAt).toBeTruthy();
    expect(result?.likeRecordCount).toBe(4);
  });
});
