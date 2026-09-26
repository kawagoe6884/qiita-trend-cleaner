import { describe, it, expect } from 'vitest';
import {
  mergeLikeIndex,
  purgeLikeIndex,
  withinLookback,
  countRecords,
  countAuthorCoverage,
  toEpochMs,
  RETENTION_DAYS,
  isWithinRetention,
} from './like-index';
import type { LikeIndex, LikeRecord } from '../types/domain';

/** 判定の基準時刻。now を固定しないとテストが実行時刻に依存して壊れる */
const NOW = new Date('2026-08-19T12:00:00+09:00');

/** NOW から days 日前の ISO 文字列 */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** フィクスチャはすべて合成値。実アカウント名・実 item_id は使わない */
function record(itemIndex: number, overrides: Partial<LikeRecord> = {}): LikeRecord {
  return {
    itemId: `0123456789abcdef${String(itemIndex).padStart(4, '0')}`,
    authorHandle: 'example-author-1',
    likedAt: daysAgo(1),
    itemPostedAt: daysAgo(1),
    ...overrides,
  };
}

function index(handle: string, likes: LikeRecord[], meta = {}): LikeIndex {
  return {
    [handle]: { likes, itemsCount: 0, followersCount: 1, hasDescription: false, ...meta },
  };
}

describe('toEpochMs', () => {
  it('オフセット付き ISO 8601 を解釈する', () => {
    expect(toEpochMs('2026-08-19T12:00:00+09:00')).toBe(NOW.getTime());
  });

  it('パースできない文字列は null（NaN を漏らさない）', () => {
    expect(toEpochMs('not-a-date')).toBeNull();
  });
});

describe('mergeLikeIndex', () => {
  it('空の蓄積に初回分をマージすると全件入る', () => {
    // Arrange
    const fresh: LikeIndex = {
      ...index('example-liker-a', [record(1)]),
      ...index('example-liker-b', [record(2)]),
    };
    // Act
    const merged = mergeLikeIndex({}, fresh);
    // Assert
    expect(Object.keys(merged).sort()).toEqual(['example-liker-a', 'example-liker-b']);
    expect(countRecords(merged)).toBe(2);
  });

  it('同じ記事を 2 回スキャンしても重複しない', () => {
    // Arrange — 同じ itemId を含む 2 回のマージ
    const first = index('example-liker-a', [record(1)]);
    const second = index('example-liker-a', [record(1)]);
    // Act
    const merged = mergeLikeIndex(first, second);
    // Assert — アカウントが同じ記事に 2 回いいねすることはない
    expect(countRecords(merged)).toBe(1);
  });

  it('別のトレンドセットの記事は追加される', () => {
    const merged = mergeLikeIndex(
      index('example-liker-a', [record(1)]),
      index('example-liker-a', [record(2)]),
    );
    expect(countRecords(merged)).toBe(2);
  });

  it('メタデータは新しい方で上書きされる', () => {
    // Arrange — アカウントは成長する
    const stored = index('example-liker-a', [record(1)], { itemsCount: 0 });
    const fresh = index('example-liker-a', [record(2)], { itemsCount: 3 });
    // Act
    const merged = mergeLikeIndex(stored, fresh);
    // Assert
    expect(merged['example-liker-a']?.itemsCount).toBe(3);
  });

  it('元のインデックスを破壊しない', () => {
    // Arrange — stored は storage から読んだ値。書き換えると呼び出し側の想定が壊れる
    const stored = index('example-liker-a', [record(1)]);
    // Act
    mergeLikeIndex(stored, index('example-liker-a', [record(2)]));
    // Assert
    expect(stored['example-liker-a']?.likes).toHaveLength(1);
  });
});

describe('purgeLikeIndex', () => {
  it('保持期間を過ぎたレコードを捨てる', () => {
    // Arrange — RETENTION_DAYS は 7
    const stored = index('example-liker-a', [
      record(1, { itemPostedAt: daysAgo(RETENTION_DAYS + 1) }),
      record(2, { itemPostedAt: daysAgo(1) }),
    ]);
    // Act
    const { index: kept, purgedRecords } = purgeLikeIndex(stored, NOW);
    // Assert
    expect(purgedRecords).toBe(1);
    expect(countRecords(kept)).toBe(1);
  });

  it('保持期間ちょうどは残す', () => {
    const stored = index('example-liker-a', [record(1, { itemPostedAt: daysAgo(RETENTION_DAYS) })]);
    expect(countRecords(purgeLikeIndex(stored, NOW).index)).toBe(1);
  });

  it('全レコードが消えたアカウントはエントリごと消える', () => {
    // Arrange — 10 MB 上限への配慮。空のエントリを残さない
    const stored = index('example-liker-a', [
      record(1, { itemPostedAt: daysAgo(RETENTION_DAYS + 5) }),
    ]);
    // Act
    const { index: kept } = purgeLikeIndex(stored, NOW);
    // Assert
    expect(kept).not.toHaveProperty('example-liker-a');
  });

  it('日時がパースできないレコードは捨て、例外は投げない', () => {
    // Arrange
    const stored = index('example-liker-a', [record(1, { itemPostedAt: 'not-a-date' }), record(2)]);
    // Act & Assert
    expect(() => purgeLikeIndex(stored, NOW)).not.toThrow();
    const { index: kept, purgedRecords } = purgeLikeIndex(stored, NOW);
    expect(purgedRecords).toBe(1);
    expect(countRecords(kept)).toBe(1);
  });

  it('元のインデックスを破壊しない', () => {
    const stored = index('example-liker-a', [
      record(1, { itemPostedAt: daysAgo(RETENTION_DAYS + 1) }),
      record(2),
    ]);
    purgeLikeIndex(stored, NOW);
    expect(stored['example-liker-a']?.likes).toHaveLength(2);
  });
});

describe('withinLookback', () => {
  it('遡及窓の外のレコードを判定対象から外す', () => {
    // Arrange — lookbackDays 3 に対して 4 日前
    const stored = index('example-liker-a', [
      record(1, { itemPostedAt: daysAgo(4) }),
      record(2, { itemPostedAt: daysAgo(2) }),
    ]);
    // Act
    const scoped = withinLookback(stored, 3, NOW);
    // Assert
    expect(countRecords(scoped)).toBe(1);
  });

  it('元のインデックスを変えない（保存には影響しない）', () => {
    // Arrange
    const stored = index('example-liker-a', [record(1, { itemPostedAt: daysAgo(4) })]);
    // Act
    const scoped = withinLookback(stored, 3, NOW);
    // Assert — 判定の絞り込みが storage の中身を削ってはいけない
    expect(countRecords(scoped)).toBe(0);
    expect(countRecords(stored)).toBe(1);
  });
});

describe('countRecords', () => {
  it('空のインデックスは 0', () => {
    expect(countRecords({})).toBe(0);
  });

  it('全アカウントのレコード数を合計する', () => {
    const stored: LikeIndex = {
      ...index('example-liker-a', [record(1), record(2)]),
      ...index('example-liker-b', [record(1)]),
    };
    expect(countRecords(stored)).toBe(3);
  });
});

/**
 * ライトモードの説明に出す実数。**数えるのは著者であって、いいねではない。**
 *
 * 記事 1 本の著者は著者内クラスタでは成立しないので、そこが
 * 「トークンを設定すると何人ぶん単独で判定できるようになるか」になる。
 */
describe('countAuthorCoverage', () => {
  /** 著者 author の記事 itemIndex への 1 いいね */
  function by(author: string, itemIndex: number): LikeRecord {
    return record(itemIndex, { authorHandle: author });
  }

  it('記事が 1 本しかない著者を数える', () => {
    // Arrange — a は 2 本、b と c は 1 本ずつ
    const stored: LikeIndex = index('example-liker-1', [
      by('example-author-a', 1),
      by('example-author-a', 2),
      by('example-author-b', 3),
      by('example-author-c', 4),
    ]);
    // Act & Assert
    expect(countAuthorCoverage(stored)).toEqual({ total: 3, solo: 2 });
  });

  it('同じ記事を複数のアカウントがいいねしても 1 本と数える', () => {
    // Arrange — **記事の本数であって、いいねの件数ではない。**
    // レコード数で数えると、人気の記事を 1 本だけ持つ著者が複数本持ちに見える
    const stored: LikeIndex = {
      ...index('example-liker-1', [by('example-author-a', 1)]),
      ...index('example-liker-2', [by('example-author-a', 1)]),
      ...index('example-liker-3', [by('example-author-a', 1)]),
    };
    // Act & Assert
    expect(countAuthorCoverage(stored)).toEqual({ total: 1, solo: 1 });
  });

  it('蓄積が空なら 0 人（例外を投げない）', () => {
    expect(countAuthorCoverage({})).toEqual({ total: 0, solo: 0 });
  });

  it('いいねが 1 件も無いアカウントは著者を増やさない', () => {
    // Arrange — purge の直後などに起こりうる形
    expect(countAuthorCoverage(index('example-liker-1', []))).toEqual({ total: 0, solo: 0 });
  });
});

/**
 * 取りに行く前の絞り込み（OQ-19）。
 *
 * **経路は scanner.test.ts が検査している**（「保持期間より古い記事は
 * 取りに行かない」「絞ってから件数で切る」）。ここは境界だけを固定する。
 * 境界を経路のテストで確かめようとすると、フィクスチャの日付を細かく
 * 動かすことになり、何を検査しているのか読めなくなる。
 */
describe('isWithinRetention', () => {
  it('今日の記事は含む', () => {
    expect(isWithinRetention(daysAgo(0), NOW)).toBe(true);
  });

  it('保持期間の内側なら含む', () => {
    expect(isWithinRetention(daysAgo(RETENTION_DAYS - 1), NOW)).toBe(true);
  });

  it('ちょうど RETENTION_DAYS 前は含む（境界は内側）', () => {
    // purgeLikeIndex の filterByCutoff が posted < cutoff で落とすのに合わせる。
    // ずれると「取ったのに保存されない」1 日ぶんの隙間ができる
    expect(isWithinRetention(daysAgo(RETENTION_DAYS), NOW)).toBe(true);
  });

  it('1 日でも超えたら含まない', () => {
    expect(isWithinRetention(daysAgo(RETENTION_DAYS + 1), NOW)).toBe(false);
  });

  it('パースできない日付は含まない', () => {
    // 「期間内」と誤判定すると、消える運命の記事に枠を使う
    expect(isWithinRetention('not-a-date', NOW)).toBe(false);
  });

  it('空文字は含まない', () => {
    expect(isWithinRetention('', NOW)).toBe(false);
  });

  it('purgeLikeIndex と同じ境界を使う', () => {
    // Arrange — ちょうど境界の記事を 1 件だけ持つインデックス
    const index: LikeIndex = {
      'example-liker-1': {
        likes: [
          {
            itemId: '0123456789abcdef0001',
            authorHandle: 'example-author-1',
            likedAt: daysAgo(RETENTION_DAYS),
            itemPostedAt: daysAgo(RETENTION_DAYS),
          },
        ],
        itemsCount: 3,
        followersCount: 10,
        hasDescription: true,
      },
    };
    // Act — 取得側で通したものが保存側で落ちないこと
    const kept = purgeLikeIndex(index, NOW);
    // Assert
    expect(isWithinRetention(daysAgo(RETENTION_DAYS), NOW)).toBe(true);
    expect(countRecords(kept.index)).toBe(1);
  });
});
