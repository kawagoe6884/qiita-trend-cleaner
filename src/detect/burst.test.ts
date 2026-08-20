import { describe, it, expect } from 'vitest';
import { burstScore, emptyAccountRatio, BURST_WINDOW_MINUTES, EMPTY_MAX_FOLLOWERS } from './burst';
import type { ClusterHit } from './cluster';
import type { LikeIndex, LikeRecord } from '../types/domain';

const POSTED = '2026-08-18T10:00:00+09:00';
const POSTED_MS = new Date(POSTED).getTime();

function itemId(n: number): string {
  return `0123456789abcdef${String(n).padStart(4, '0')}`;
}

/** 投稿から minutes 分後にいいねした記録 */
function likedAfter(minutes: number): string {
  return new Date(POSTED_MS + minutes * 60 * 1000).toISOString();
}

function record(
  n: number,
  minutesAfterPost: number,
  overrides: Partial<LikeRecord> = {},
): LikeRecord {
  return {
    itemId: itemId(n),
    authorHandle: 'example-author-a',
    likedAt: likedAfter(minutesAfterPost),
    itemPostedAt: POSTED,
    ...overrides,
  };
}

function entry(likes: LikeRecord[], meta = {}) {
  return { likes, itemsCount: 0, followersCount: 1, hasDescription: false, ...meta };
}

const HIT: ClusterHit = {
  authorHandle: 'example-author-a',
  clusterAccounts: ['example-liker-1', 'example-liker-2'],
  sharedItemIds: [itemId(1), itemId(2)],
};

describe('burstScore', () => {
  it('全員が投稿直後なら 1.0', () => {
    // Arrange
    const index: LikeIndex = {
      'example-liker-1': entry([record(1, 10), record(2, 10)]),
      'example-liker-2': entry([record(1, 5), record(2, 5)]),
    };
    // Act & Assert
    expect(burstScore(index, HIT)).toBe(1);
  });

  it('全員が翌日なら 0.0', () => {
    const index: LikeIndex = {
      'example-liker-1': entry([record(1, 60 * 24), record(2, 60 * 24)]),
      'example-liker-2': entry([record(1, 60 * 30), record(2, 60 * 30)]),
    };
    expect(burstScore(index, HIT)).toBe(0);
  });

  it('半々なら 0.5', () => {
    // Arrange — 2 件が窓内、2 件が窓外
    const index: LikeIndex = {
      'example-liker-1': entry([record(1, 10), record(2, 10)]),
      'example-liker-2': entry([record(1, 600), record(2, 600)]),
    };
    // Act & Assert
    expect(burstScore(index, HIT)).toBe(0.5);
  });

  it('ちょうど 60 分は窓内に入れる', () => {
    // Arrange — 境界。<= か < かで結果が変わる
    const index: LikeIndex = {
      'example-liker-1': entry([record(1, BURST_WINDOW_MINUTES), record(2, BURST_WINDOW_MINUTES)]),
      'example-liker-2': entry([record(1, 1), record(2, 1)]),
    };
    // Act & Assert
    expect(burstScore(index, HIT)).toBe(1);
  });

  it('61 分は窓外', () => {
    const index: LikeIndex = {
      'example-liker-1': entry([
        record(1, BURST_WINDOW_MINUTES + 1),
        record(2, BURST_WINDOW_MINUTES + 1),
      ]),
      'example-liker-2': entry([record(1, 1), record(2, 1)]),
    };
    expect(burstScore(index, HIT)).toBe(0.5);
  });

  it('記事投稿より前のいいねは分母からも除く', () => {
    // Arrange — データ不整合。分母に残すとスコアを不当に下げる
    const index: LikeIndex = {
      'example-liker-1': entry([record(1, -120), record(2, 10)]),
      'example-liker-2': entry([record(1, 10), record(2, 10)]),
    };
    // Act & Assert — 有効な 3 件がすべて窓内なので 1.0
    expect(burstScore(index, HIT)).toBe(1);
  });

  it('パースできない日時は分母からも除き、例外を投げない', () => {
    // Arrange
    const index: LikeIndex = {
      'example-liker-1': entry([record(1, 10, { likedAt: 'not-a-date' }), record(2, 10)]),
      'example-liker-2': entry([record(1, 10), record(2, 10, { itemPostedAt: 'not-a-date' })]),
    };
    // Act & Assert
    expect(() => burstScore(index, HIT)).not.toThrow();
    expect(burstScore(index, HIT)).toBe(1);
  });

  it('sharedItems 以外の記事は数えない', () => {
    // Arrange — 記事 3 は sharedItemIds に無い
    const index: LikeIndex = {
      'example-liker-1': entry([record(1, 10), record(2, 10), record(3, 9999)]),
      'example-liker-2': entry([record(1, 10), record(2, 10)]),
    };
    // Act & Assert
    expect(burstScore(index, HIT)).toBe(1);
  });

  it('対象レコードが 0 件なら 0.0（NaN にしない）', () => {
    // Act & Assert
    const score = burstScore({}, HIT);
    expect(score).toBe(0);
    expect(Number.isNaN(score)).toBe(false);
  });
});

describe('emptyAccountRatio', () => {
  const accounts = ['example-liker-1', 'example-liker-2'];

  it('全員が空なら 1.0', () => {
    // Arrange — 記事 0 本・プロフィール空・フォロワー 0
    const index: LikeIndex = {
      'example-liker-1': entry([], { itemsCount: 0, followersCount: 0, hasDescription: false }),
      'example-liker-2': entry([], { itemsCount: 0, followersCount: 0, hasDescription: false }),
    };
    // Act & Assert
    expect(emptyAccountRatio(index, accounts)).toBe(1);
  });

  it('記事を書いていれば空扱いしない', () => {
    const index: LikeIndex = {
      'example-liker-1': entry([], { itemsCount: 4 }),
      'example-liker-2': entry([], { itemsCount: 0, followersCount: 0 }),
    };
    expect(emptyAccountRatio(index, accounts)).toBe(0.5);
  });

  it('プロフィールがあれば空扱いしない', () => {
    const index: LikeIndex = {
      'example-liker-1': entry([], { hasDescription: true, followersCount: 0 }),
      'example-liker-2': entry([], { followersCount: 0 }),
    };
    expect(emptyAccountRatio(index, accounts)).toBe(0.5);
  });

  it('フォロワーが閾値を超えたら空扱いしない', () => {
    // Arrange — 境界のすぐ外
    const index: LikeIndex = {
      'example-liker-1': entry([], { followersCount: EMPTY_MAX_FOLLOWERS + 1 }),
      'example-liker-2': entry([], { followersCount: EMPTY_MAX_FOLLOWERS }),
    };
    // Act & Assert
    expect(emptyAccountRatio(index, accounts)).toBe(0.5);
  });

  it('空配列なら 0.0（NaN にしない）', () => {
    const ratio = emptyAccountRatio({}, []);
    expect(ratio).toBe(0);
    expect(Number.isNaN(ratio)).toBe(false);
  });

  it('インデックスに居ないアカウントは空扱いしない', () => {
    expect(emptyAccountRatio({}, accounts)).toBe(0);
  });
});
