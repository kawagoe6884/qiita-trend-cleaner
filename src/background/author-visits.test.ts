import { describe, it, expect } from 'vitest';
import { authorsToVisit, recordVisits, pruneVisits, AUTHOR_REVISIT_HOURS } from './author-visits';
import type { AuthorVisits, LikeIndex } from '../types/domain';

/**
 * 時刻は引数で受け取る設計なので、フェイクタイマーは要らない。
 * 固定した NOW からの相対でフィクスチャを作る。
 */
const NOW = new Date('2026-08-19T12:00:00+09:00');

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/** 合成のインデックス。実アカウント名・実 item_id は使わない */
function indexWithAuthors(...authors: string[]): LikeIndex {
  return {
    'example-liker-1': {
      likes: authors.map((authorHandle, i) => ({
        itemId: `0123456789abcdef000${String(i + 1)}`,
        authorHandle,
        likedAt: '2026-08-19T06:00:00+09:00',
        itemPostedAt: '2026-08-19T05:30:00+09:00',
      })),
      itemsCount: 3,
      followersCount: 10,
      hasDescription: true,
    },
  };
}

describe('authorsToVisit', () => {
  it('まだ訪れていない著者は返す', () => {
    // Arrange
    const handles = ['example-author-1', 'example-author-2'];
    // Act & Assert
    expect(authorsToVisit(handles, {}, NOW).sort()).toEqual(handles);
  });

  it('23 時間前に訪れた著者は返さない', () => {
    // Arrange — 間隔の内側
    const visits: AuthorVisits = { 'example-author-1': hoursAgo(23) };
    // Act & Assert
    expect(authorsToVisit(['example-author-1'], visits, NOW)).toEqual([]);
  });

  it('25 時間前なら返す', () => {
    const visits: AuthorVisits = { 'example-author-1': hoursAgo(25) };
    expect(authorsToVisit(['example-author-1'], visits, NOW)).toEqual(['example-author-1']);
  });

  it('ちょうど AUTHOR_REVISIT_HOURS 経ったら返す（境界は再訪側）', () => {
    // Arrange — 比較を <= から < に変えると落ちる
    const visits: AuthorVisits = { 'example-author-1': hoursAgo(AUTHOR_REVISIT_HOURS) };
    // Act & Assert
    expect(authorsToVisit(['example-author-1'], visits, NOW)).toEqual(['example-author-1']);
  });

  it('同じ著者が 2 本出ても 1 回にまとめる', () => {
    // Arrange — トレンドに同じ著者の記事が 2 本あるのは常態（実測で 5 著者が 30 枠中 13）
    const handles = ['example-author-1', 'example-author-1'];
    // Act & Assert — 畳まないと同じ著者一覧を 2 回叩く
    expect(authorsToVisit(handles, {}, NOW)).toEqual(['example-author-1']);
  });

  it('パースできない記録は未訪問として扱う', () => {
    // Arrange — 訪ねすぎる方が、永久に訪ねないより無害
    const visits: AuthorVisits = { 'example-author-1': 'not-a-date' };
    // Act & Assert
    expect(authorsToVisit(['example-author-1'], visits, NOW)).toEqual(['example-author-1']);
  });

  it('空の入力では何も返さない', () => {
    expect(authorsToVisit([], {}, NOW)).toEqual([]);
  });

  it('記録にあるが今回のトレンドに居ない著者は返さない', () => {
    // Arrange — 巡回対象は「いま画面に出ている著者」だけ
    const visits: AuthorVisits = { 'example-author-9': hoursAgo(48) };
    // Act & Assert
    expect(authorsToVisit(['example-author-1'], visits, NOW)).toEqual(['example-author-1']);
  });
});

describe('recordVisits', () => {
  it('訪問した著者の時刻を now にする', () => {
    // Act
    const next = recordVisits({}, ['example-author-1'], NOW);
    // Assert
    expect(next['example-author-1']).toBe(NOW.toISOString());
  });

  it('元のオブジェクトを書き換えない', () => {
    // Arrange
    const visits: AuthorVisits = { 'example-author-1': hoursAgo(48) };
    // Act
    const next = recordVisits(visits, ['example-author-1'], NOW);
    // Assert — 破壊的更新にすると落ちる
    expect(visits['example-author-1']).toBe(hoursAgo(48));
    expect(next).not.toBe(visits);
  });

  it('他の著者の記録は残す', () => {
    const visits: AuthorVisits = { 'example-author-2': hoursAgo(48) };
    const next = recordVisits(visits, ['example-author-1'], NOW);
    expect(next['example-author-2']).toBe(hoursAgo(48));
  });

  it('記録した直後は再訪の対象にならない', () => {
    // Arrange & Act — recordVisits と authorsToVisit が同じ時刻の見方をしていること
    const next = recordVisits({}, ['example-author-1'], NOW);
    // Assert
    expect(authorsToVisit(['example-author-1'], next, NOW)).toEqual([]);
  });
});

describe('pruneVisits', () => {
  it('インデックスに居ない著者の記録を落とす', () => {
    // Arrange — 保持期間を過ぎて index から消えた著者
    const visits: AuthorVisits = { 'example-author-1': hoursAgo(1) };
    // Act & Assert — 残すと「訪問済み」として飛ばし続けることになる
    expect(pruneVisits(visits, {})).toEqual({});
  });

  it('インデックスに居る著者の記録は残す', () => {
    const visits: AuthorVisits = { 'example-author-1': hoursAgo(1) };
    expect(pruneVisits(visits, indexWithAuthors('example-author-1'))).toEqual(visits);
  });

  it('居る著者と居ない著者が混ざっていても選り分ける', () => {
    // Arrange
    const visits: AuthorVisits = {
      'example-author-1': hoursAgo(1),
      'example-author-2': hoursAgo(2),
    };
    // Act
    const kept = pruneVisits(visits, indexWithAuthors('example-author-2'));
    // Assert
    expect(Object.keys(kept)).toEqual(['example-author-2']);
  });

  it('元のオブジェクトを書き換えない', () => {
    const visits: AuthorVisits = { 'example-author-1': hoursAgo(1) };
    pruneVisits(visits, {});
    expect(Object.keys(visits)).toEqual(['example-author-1']);
  });
});
