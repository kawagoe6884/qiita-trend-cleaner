import { describe, it, expect } from 'vitest';
import { detectCandidates } from './detector';
import { DEFAULT_SETTINGS } from '../types/domain';
import type { LikeIndex, LikeRecord } from '../types/domain';

const NOW = new Date('2026-08-19T12:00:00+09:00');

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function itemId(n: number): string {
  return `0123456789abcdef${String(n).padStart(4, '0')}`;
}

/**
 * 著者 author の記事 items に、count 人が一斉にいいねした状態を作る。
 * postedHoursAgo で遡及窓の内外を、burstMinutes で投稿からの経過を制御する。
 */
function cluster(options: {
  author: string;
  items: number[];
  accounts: number;
  postedHoursAgo?: number;
  burstMinutes?: number;
  empty?: boolean;
}): LikeIndex {
  const postedHours = options.postedHoursAgo ?? 24;
  const burst = options.burstMinutes ?? 10;
  const postedAt = hoursAgo(postedHours);
  const likedAt = new Date(new Date(postedAt).getTime() + burst * 60 * 1000).toISOString();

  const index: LikeIndex = {};
  for (let i = 1; i <= options.accounts; i += 1) {
    const likes: LikeRecord[] = options.items.map((n) => ({
      itemId: itemId(n),
      authorHandle: options.author,
      likedAt,
      itemPostedAt: postedAt,
    }));
    index[`example-liker-${String(i)}`] = {
      likes,
      itemsCount: options.empty === false ? 7 : 0,
      followersCount: options.empty === false ? 50 : 0,
      hasDescription: options.empty === false,
    };
  }
  return index;
}

/** 複数のクラスタを 1 つのインデックスに合わせる（同じアカウントの likes は連結する） */
function mergeIndexes(...parts: LikeIndex[]): LikeIndex {
  const index: LikeIndex = {};
  for (const part of parts) {
    for (const [handle, entry] of Object.entries(part)) {
      const existing = index[handle];
      index[handle] =
        existing === undefined
          ? entry
          : { ...existing, likes: [...existing.likes, ...entry.likes] };
    }
  }
  return index;
}

describe('detectCandidates', () => {
  it('ライトモード相当の入力でも検出できる（OQ-12 の単体再現）', () => {
    // Arrange — 同一トレンドセット内で、同一著者の 2 記事に 5 人が揃う。
    // トレンド 30 件の中に同一著者が 2 本入っていれば、蓄積なしでも成立する
    const index = cluster({ author: 'example-author-a', items: [1, 2], accounts: 5 });
    // Act
    const candidates = detectCandidates(index, DEFAULT_SETTINGS, NOW);
    // Assert
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.authorHandle).toBe('example-author-a');
  });

  it('遡及窓の外の記事は判定に入らない', () => {
    // Arrange — lookbackDays 3 に対して 4 日前の記事
    const index = cluster({
      author: 'example-author-a',
      items: [1, 2],
      accounts: 5,
      postedHoursAgo: 24 * 4,
    });
    // Act & Assert
    expect(detectCandidates(index, DEFAULT_SETTINGS, NOW)).toEqual([]);
  });

  it('Candidate の全フィールドが埋まる', () => {
    // Arrange
    const index = cluster({ author: 'example-author-a', items: [1, 2], accounts: 5 });
    // Act
    const candidate = detectCandidates(index, DEFAULT_SETTINGS, NOW)[0];
    // Assert
    expect(candidate).toMatchObject({
      authorHandle: 'example-author-a',
      clusterSize: 5,
      sharedItemCount: 2,
    });
    expect(candidate?.clusterAccounts).toHaveLength(5);
    expect(candidate?.sharedItemIds).toEqual([itemId(1), itemId(2)]);
    expect(candidate?.burstScore).toBe(1);
    expect(candidate?.emptyAccountRatio).toBe(1);
  });

  it('detectedAt は渡した now になる（実行時刻に依存しない）', () => {
    const index = cluster({ author: 'example-author-a', items: [1, 2], accounts: 5 });
    const candidate = detectCandidates(index, DEFAULT_SETTINGS, NOW)[0];
    expect(candidate?.detectedAt).toBe(NOW.toISOString());
  });

  it('投稿から時間が経ったいいねは burstScore が下がる', () => {
    // Arrange — 投稿の 10 時間後
    const index = cluster({
      author: 'example-author-a',
      items: [1, 2],
      accounts: 5,
      burstMinutes: 600,
    });
    // Act & Assert
    expect(detectCandidates(index, DEFAULT_SETTINGS, NOW)[0]?.burstScore).toBe(0);
  });

  it('中身のあるアカウントなら emptyAccountRatio が 0 になる', () => {
    const index = cluster({
      author: 'example-author-a',
      items: [1, 2],
      accounts: 5,
      empty: false,
    });
    expect(detectCandidates(index, DEFAULT_SETTINGS, NOW)[0]?.emptyAccountRatio).toBe(0);
  });

  it('クラスタサイズの降順に並ぶ', () => {
    // Arrange — 著者 A に 5 人、著者 B に 7 人
    const index = mergeIndexes(
      cluster({ author: 'example-author-b', items: [3, 4], accounts: 7 }),
      cluster({ author: 'example-author-a', items: [1, 2], accounts: 5 }),
    );
    // Act
    const candidates = detectCandidates(index, DEFAULT_SETTINGS, NOW);
    // Assert
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.clusterSize).toBe(7);
    expect(candidates[1]?.clusterSize).toBe(5);
  });

  it('クラスタサイズが同じならバーストが強い方を先に出す', () => {
    // Arrange — どちらも 5 人。著者 A は投稿 10 分後、著者 B は 10 時間後。
    // タイブレークが無い（または逆順）と、怪しい方が下に沈む
    const index = mergeIndexes(
      cluster({ author: 'example-author-b', items: [3, 4], accounts: 5, burstMinutes: 600 }),
      cluster({ author: 'example-author-a', items: [1, 2], accounts: 5, burstMinutes: 10 }),
    );
    // Act
    const candidates = detectCandidates(index, DEFAULT_SETTINGS, NOW);
    // Assert
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.authorHandle).toBe('example-author-a');
    expect(candidates[0]?.burstScore).toBe(1);
    expect(candidates[1]?.burstScore).toBe(0);
  });

  it('閾値に届かなければ空配列（null ではない）', () => {
    const index = cluster({ author: 'example-author-a', items: [1, 2], accounts: 3 });
    expect(detectCandidates(index, DEFAULT_SETTINGS, NOW)).toEqual([]);
  });

  it('空のインデックスでも例外を投げない', () => {
    expect(() => detectCandidates({}, DEFAULT_SETTINGS, NOW)).not.toThrow();
    expect(detectCandidates({}, DEFAULT_SETTINGS, NOW)).toEqual([]);
  });
});
