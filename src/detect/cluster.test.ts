import { describe, it, expect } from 'vitest';
import { findClusters } from './cluster';
import type { LikeIndex, Settings } from '../types/domain';

const SETTINGS: Settings = { minClusterSize: 5, minSharedItems: 2, lookbackDays: 3 };

const POSTED = '2026-08-18T10:00:00+09:00';
const LIKED = '2026-08-18T10:30:00+09:00';

function itemId(n: number): string {
  return `0123456789abcdef${String(n).padStart(4, '0')}`;
}

/**
 * 「誰が・どの記事に・誰の記事か」を明示的に組み立てる。
 * 引数は account -> [author, itemNumber][] の対応表。
 * ヘルパーで隠すとテストが何を主張しているのか読めなくなるため、
 * 呼び出し側に一覧を書かせる。
 */
function buildIndex(likes: Record<string, [string, number][]>): LikeIndex {
  const index: LikeIndex = {};
  for (const [account, pairs] of Object.entries(likes)) {
    index[account] = {
      likes: pairs.map(([author, n]) => ({
        itemId: itemId(n),
        authorHandle: author,
        likedAt: LIKED,
        itemPostedAt: POSTED,
      })),
      itemsCount: 0,
      followersCount: 1,
      hasDescription: false,
    };
  }
  return index;
}

/** account 1..count が、著者 author の記事 items 全部にいいねした状態 */
function solidCluster(author: string, items: number[], count: number): LikeIndex {
  const likes: Record<string, [string, number][]> = {};
  for (let i = 1; i <= count; i += 1) {
    likes[`example-liker-${String(i)}`] = items.map((n) => [author, n] as [string, number]);
  }
  return buildIndex(likes);
}

describe('findClusters', () => {
  it('N 人が同一著者の M 本に揃えば検出する', () => {
    // Arrange — 5 アカウントが著者 A の 2 記事すべてにいいね
    const index = solidCluster('example-author-a', [1, 2], 5);
    // Act
    const hits = findClusters(index, SETTINGS);
    // Assert
    expect(hits).toHaveLength(1);
    expect(hits[0]?.authorHandle).toBe('example-author-a');
    expect(hits[0]?.clusterAccounts).toHaveLength(5);
    expect(hits[0]?.sharedItemIds).toHaveLength(2);
  });

  it('N に 1 人足りなければ検出しない', () => {
    const index = solidCluster('example-author-a', [1, 2], 4);
    expect(findClusters(index, SETTINGS)).toEqual([]);
  });

  it('M に 1 本足りなければ検出しない', () => {
    // Arrange — 5 人いても記事が 1 本では共起にならない
    const index = solidCluster('example-author-a', [1], 5);
    expect(findClusters(index, SETTINGS)).toEqual([]);
  });

  it('手順 3 は通るが手順 4 で落ちる（顔ぶれが揃っていない）', () => {
    // Arrange — 6 人全員が「著者 A の 2 本」をいいねしているので手順 3 は通る。
    // だが記事ごとの顔ぶれは 3 人ずつに割れており、同じ顔ぶれが揃っていない
    const index = buildIndex({
      'example-liker-1': [
        ['example-author-a', 1],
        ['example-author-a', 2],
      ],
      'example-liker-2': [
        ['example-author-a', 1],
        ['example-author-a', 2],
      ],
      'example-liker-3': [
        ['example-author-a', 1],
        ['example-author-a', 2],
      ],
      'example-liker-4': [
        ['example-author-a', 3],
        ['example-author-a', 4],
      ],
      'example-liker-5': [
        ['example-author-a', 3],
        ['example-author-a', 4],
      ],
      'example-liker-6': [
        ['example-author-a', 3],
        ['example-author-a', 4],
      ],
    });
    // Act
    const hits = findClusters(index, SETTINGS);
    // Assert — これを検出すると「別々の集団がそれぞれ 2 本ずつ」を組織票と誤認する
    expect(hits).toEqual([]);
  });

  it('揃っている記事だけが sharedItemIds に入る', () => {
    // Arrange — 5 人が記事 1,2 に揃い、記事 3 は 1 人だけ
    const index = solidCluster('example-author-a', [1, 2], 5);
    index['example-liker-1']?.likes.push({
      itemId: itemId(3),
      authorHandle: 'example-author-a',
      likedAt: LIKED,
      itemPostedAt: POSTED,
    });
    // Act
    const hits = findClusters(index, SETTINGS);
    // Assert
    expect(hits[0]?.sharedItemIds).toEqual([itemId(1), itemId(2)]);
  });

  it('著者が違えば別候補になる', () => {
    // Arrange — 同じ顔ぶれが 2 著者にまたがる（一次証拠と同じ形）
    const index = buildIndex(
      Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [
          `example-liker-${String(i + 1)}`,
          [
            ['example-author-a', 1],
            ['example-author-a', 2],
            ['example-author-b', 3],
            ['example-author-b', 4],
          ] as [string, number][],
        ]),
      ),
    );
    // Act
    const hits = findClusters(index, SETTINGS);
    // Assert — 著者ごとに 1 件ずつ出す（1 つにまとめない）
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.authorHandle).sort()).toEqual([
      'example-author-a',
      'example-author-b',
    ]);
  });

  it('M 本に満たないアカウントはクラスタに数えない', () => {
    // Arrange — 5 人は 2 本ずつ、あと 3 人は 1 本だけ。
    // 1 本だけの人を数えると顔ぶれが 8 人に膨らみ、規模を実態より大きく見せる。
    // 記事 1 本にいいねしただけの読者は、組織票の証拠にならない
    const index: LikeIndex = {
      ...solidCluster('example-author-a', [1, 2], 5),
      ...buildIndex({
        'example-reader-1': [['example-author-a', 1]],
        'example-reader-2': [['example-author-a', 1]],
        'example-reader-3': [['example-author-a', 2]],
      }),
    };
    // Act
    const hits = findClusters(index, SETTINGS);
    // Assert
    expect(hits).toHaveLength(1);
    expect(hits[0]?.clusterAccounts).toHaveLength(5);
    expect(hits[0]?.clusterAccounts).not.toContain('example-reader-1');
  });

  it('空のインデックスは空配列', () => {
    expect(findClusters({}, SETTINGS)).toEqual([]);
  });

  it('1 アカウントだけなら検出しない', () => {
    const index = solidCluster('example-author-a', [1, 2], 1);
    expect(findClusters(index, SETTINGS)).toEqual([]);
  });

  it('結果はソートされている', () => {
    // Arrange — 意図的に逆順で作る
    const index = buildIndex(
      Object.fromEntries(
        [9, 8, 7, 6, 5].map((i) => [
          `example-liker-${String(i)}`,
          [
            ['example-author-a', 2],
            ['example-author-a', 1],
          ] as [string, number][],
        ]),
      ),
    );
    // Act
    const hit = findClusters(index, SETTINGS)[0];
    // Assert
    expect(hit?.clusterAccounts).toEqual([...(hit?.clusterAccounts ?? [])].sort());
    expect(hit?.sharedItemIds).toEqual([itemId(1), itemId(2)]);
  });
});
