import { describe, it, expect } from 'vitest';
import { findCrossAuthorClusters } from './cross-cluster';
import type { LikeIndex, Settings } from '../types/domain';

const SETTINGS: Settings = { minClusterSize: 5, minSharedItems: 2, lookbackDays: 7 };

/** 合成の item_id。実 item_id は使わない */
function itemId(n: number): string {
  return `0123456789abcdef${String(n).padStart(4, '0')}`;
}

/** 合成のいいね者。実アカウント名は使わない */
function likers(count: number, prefix = 'example-liker'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1)}`);
}

interface ItemSpec {
  item: number;
  author: string;
  likers: string[];
}

/** 記事と、それをいいねした人からインデックスを組み立てる */
function indexOf(specs: ItemSpec[]): LikeIndex {
  const index: LikeIndex = {};
  for (const spec of specs) {
    for (const liker of spec.likers) {
      const entry = index[liker] ?? {
        likes: [],
        itemsCount: 3,
        followersCount: 10,
        hasDescription: true,
      };
      entry.likes.push({
        itemId: itemId(spec.item),
        authorHandle: spec.author,
        likedAt: '2026-08-19T06:00:00+09:00',
        itemPostedAt: '2026-08-19T05:30:00+09:00',
      });
      index[liker] = entry;
    }
  }
  return index;
}

describe('findCrossAuthorClusters', () => {
  it('別々の著者が 1 本ずつでも、同じ顔ぶれが揃えば両方を返す', () => {
    // Arrange — 実測（2026-08-23）の再現。cluster.ts では原理的に検出できない形
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5) },
      { item: 2, author: 'example-author-b', likers: likers(5) },
    ]);
    // Act
    const hits = findCrossAuthorClusters(index, SETTINGS);
    // Assert
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.authorHandle)).toEqual(['example-author-a', 'example-author-b']);
  });

  it('同じ著者の記事だけなら成立しない（cluster.ts の担当）', () => {
    // Arrange — **この性質は著者チェックと「著者が 2 人以上」の両方が守っている。**
    // 著者チェックだけを外しても、下の sharedByAuthor.size < 2 で落ちる
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5) },
      { item: 2, author: 'example-author-a', likers: likers(5) },
    ]);
    // Act & Assert
    expect(findCrossAuthorClusters(index, SETTINGS)).toEqual([]);
  });

  it('重なりが N 人未満なら成立しない', () => {
    // Arrange — 4 人（閾値 5）
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(4) },
      { item: 2, author: 'example-author-b', likers: likers(4) },
    ]);
    // Act & Assert
    expect(findCrossAuthorClusters(index, SETTINGS)).toEqual([]);
  });

  it('N 人ちょうどで成立する（境界）', () => {
    // Arrange — 比較を >= から > に変えると落ちる
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5) },
      { item: 2, author: 'example-author-b', likers: likers(5) },
    ]);
    // Act & Assert
    expect(findCrossAuthorClusters(index, SETTINGS)).toHaveLength(2);
  });

  it('顔ぶれが違えば、人数が揃っても成立しない', () => {
    // Arrange — 記事 1 に 5 人、記事 2 に **別の** 5 人。
    // 「M 本以上いいねした人が N 人」という数え方だと通ってしまう形
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5, 'example-x') },
      { item: 2, author: 'example-author-b', likers: likers(5, 'example-y') },
    ]);
    // Act & Assert
    expect(findCrossAuthorClusters(index, SETTINGS)).toEqual([]);
  });

  it('sharedItemIds には自分の記事だけが入る', () => {
    // Arrange — popup-state.ts が根拠 URL を authorHandle から組み立てるため、
    // 他著者の記事 ID が混ざると **誤った記事をユーザーに見せる**
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5) },
      { item: 2, author: 'example-author-b', likers: likers(5) },
    ]);
    // Act
    const hits = findCrossAuthorClusters(index, SETTINGS);
    // Assert
    expect(hits[0]?.sharedItemIds).toEqual([itemId(1)]);
    expect(hits[1]?.sharedItemIds).toEqual([itemId(2)]);
  });

  it('clusterAccounts は重なった顔ぶれを昇順で返す', () => {
    // Arrange
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5) },
      { item: 2, author: 'example-author-b', likers: likers(5) },
    ]);
    // Act
    const [hit] = findCrossAuthorClusters(index, SETTINGS);
    // Assert — 表示順とテストを安定させるため
    expect(hit?.clusterAccounts).toEqual(likers(5).sort());
  });

  it('記事の総数が M 本未満なら成立しない', () => {
    // Arrange — 2 著者 1 本ずつ = 計 2 本。minSharedItems を 3 にすると届かない
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5) },
      { item: 2, author: 'example-author-b', likers: likers(5) },
    ]);
    // Act & Assert
    expect(findCrossAuthorClusters(index, { ...SETTINGS, minSharedItems: 3 })).toEqual([]);
  });

  it('3 著者にまたがっても全員を返す', () => {
    // Arrange
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5) },
      { item: 2, author: 'example-author-b', likers: likers(5) },
      { item: 3, author: 'example-author-c', likers: likers(5) },
    ]);
    // Act
    const hits = findCrossAuthorClusters(index, SETTINGS);
    // Assert
    expect(hits).toHaveLength(3);
  });

  it('重なりのない記事は結果に含まれない', () => {
    // Arrange — 3 本目は無関係な読者だけ
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5) },
      { item: 2, author: 'example-author-b', likers: likers(5) },
      { item: 3, author: 'example-author-c', likers: likers(5, 'example-reader') },
    ]);
    // Act
    const hits = findCrossAuthorClusters(index, SETTINGS);
    // Assert
    expect(hits.map((hit) => hit.authorHandle)).toEqual(['example-author-a', 'example-author-b']);
  });

  it('同じ著者が複数記事を出していても、他著者との重なりで成立する', () => {
    // Arrange — 実測では B が 2 本、A が 1 本だった
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5) },
      { item: 2, author: 'example-author-b', likers: likers(5) },
      { item: 3, author: 'example-author-b', likers: likers(5) },
    ]);
    // Act
    const hits = findCrossAuthorClusters(index, SETTINGS);
    // Assert — B の 2 本がまとまる
    expect(hits).toHaveLength(2);
    expect(hits[1]?.sharedItemIds).toEqual([itemId(2), itemId(3)]);
  });

  it('空のインデックスでは空配列を返す（例外を投げない）', () => {
    expect(() => findCrossAuthorClusters({}, SETTINGS)).not.toThrow();
    expect(findCrossAuthorClusters({}, SETTINGS)).toEqual([]);
  });

  it('記事が 1 本しかなければ成立しない', () => {
    const index = indexOf([{ item: 1, author: 'example-author-a', likers: likers(5) }]);
    expect(findCrossAuthorClusters(index, SETTINGS)).toEqual([]);
  });
});

/**
 * 著者チェック（同じ著者のペアを数えない）を直接守る。
 *
 * 「同じ著者だけなら成立しない」は sharedByAuthor.size < 2 でも守られるので、
 * 著者チェックを外しても落ちない。**落ちない理由を確かめるまで、テストが
 * 何を守っているかは分からない**（CLAUDE.md の教訓）。
 */
describe('findCrossAuthorClusters の著者チェック', () => {
  it('同じ著者どうしのペアを sharedItemIds に混ぜない', () => {
    // Arrange — A の記事 1・2 は X グループ、記事 3 は Y グループ。
    // B の記事 4 も Y グループなので、またぐのは 3-4 のペアだけ
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5, 'example-x') },
      { item: 2, author: 'example-author-a', likers: likers(5, 'example-x') },
      { item: 3, author: 'example-author-a', likers: likers(5, 'example-y') },
      { item: 4, author: 'example-author-b', likers: likers(5, 'example-y') },
    ]);
    // Act
    const hits = findCrossAuthorClusters(index, SETTINGS);
    // Assert — 記事 1・2 の共起は cluster.ts の担当。ここに混ぜると
    // 根拠として無関係な記事をユーザーに見せる
    const a = hits.find((hit) => hit.authorHandle === 'example-author-a');
    expect(a?.sharedItemIds).toEqual([itemId(3)]);
  });

  it('同じ著者どうしのペアで clusterAccounts を膨らませない', () => {
    // Arrange — 同じ配置
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5, 'example-x') },
      { item: 2, author: 'example-author-a', likers: likers(5, 'example-x') },
      { item: 3, author: 'example-author-a', likers: likers(5, 'example-y') },
      { item: 4, author: 'example-author-b', likers: likers(5, 'example-y') },
    ]);
    // Act
    const [hit] = findCrossAuthorClusters(index, SETTINGS);
    // Assert — X グループはまたいでいないので入らない
    expect(hit?.clusterAccounts).toEqual(likers(5, 'example-y').sort());
  });
});

/**
 * 連結成分の分離。**orch-review の HIGH 指摘（2026-08-24）の番人。**
 *
 * 成立したペアを 1 つの集合に貯めていたため、独立した 2 つの組織が同時に
 * 成立すると顔ぶれが混ざっていた。UI が「同じ顔ぶれが〈重なりゼロの著者〉の
 * 記事にも現れています」と事実でないことを述べ、clusterSize が膨らみ、
 * emptyAccountRatio が無関係なアカウントで希釈される。
 *
 * 実装当時のテストは **すべて 1 つの連結クリーク** しか作っておらず、
 * この経路を 1 度も通っていなかった。
 */
describe('findCrossAuthorClusters の連結成分', () => {
  /** 独立した 2 つの組織。アカウントも著者も一切重ならない */
  function twoIndependentRings(): LikeIndex {
    return indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5, 'example-x') },
      { item: 2, author: 'example-author-b', likers: likers(5, 'example-x') },
      { item: 3, author: 'example-author-c', likers: likers(5, 'example-y') },
      { item: 4, author: 'example-author-d', likers: likers(5, 'example-y') },
    ]);
  }

  it('独立した 2 つの組織を両方とも検出する', () => {
    // Act
    const hits = findCrossAuthorClusters(twoIndependentRings(), SETTINGS);
    // Assert — 4 著者すべてが候補になる
    expect(hits.map((hit) => hit.authorHandle)).toEqual([
      'example-author-a',
      'example-author-b',
      'example-author-c',
      'example-author-d',
    ]);
  });

  it('別の組織の顔ぶれを clusterAccounts に混ぜない', () => {
    // Act
    const hits = findCrossAuthorClusters(twoIndependentRings(), SETTINGS);
    // Assert — 混ざると clusterSize が 5 → 10 に膨らみ、並び順も狂う
    const a = hits.find((hit) => hit.authorHandle === 'example-author-a');
    expect(a?.clusterAccounts).toEqual(likers(5, 'example-x').sort());
  });

  it('別の組織の著者を coAuthors に入れない', () => {
    // Act
    const hits = findCrossAuthorClusters(twoIndependentRings(), SETTINGS);
    // Assert — 入れると UI が「同じ顔ぶれが c、d の記事にも」と嘘をつく
    const a = hits.find((hit) => hit.authorHandle === 'example-author-a');
    expect(a?.coAuthors).toEqual(['example-author-b']);
  });

  it('記事の本数は成分ごとに数える', () => {
    // Arrange & Act — 各成分は 2 本ずつ。全体では 4 本あるが、成分では足りない
    const hits = findCrossAuthorClusters(twoIndependentRings(), {
      ...SETTINGS,
      minSharedItems: 3,
    });
    // Assert — 全体で数えると別の組織の記事で本数を満たしてしまう
    expect(hits).toEqual([]);
  });

  it('数珠つなぎの 3 著者は 1 つの成分になる', () => {
    // Arrange — a-b は X グループ、b-c は Y グループで繋がる。
    // a と c に直接の重なりは無いが、b を介して同じ組織とみなす
    const index = indexOf([
      { item: 1, author: 'example-author-a', likers: likers(5, 'example-x') },
      {
        item: 2,
        author: 'example-author-b',
        likers: [...likers(5, 'example-x'), ...likers(5, 'example-y')],
      },
      { item: 3, author: 'example-author-c', likers: likers(5, 'example-y') },
    ]);
    // Act
    const hits = findCrossAuthorClusters(index, SETTINGS);
    // Assert
    const a = hits.find((hit) => hit.authorHandle === 'example-author-a');
    expect(a?.coAuthors).toEqual(['example-author-b', 'example-author-c']);
    expect(a?.clusterAccounts).toHaveLength(10);
  });
});
