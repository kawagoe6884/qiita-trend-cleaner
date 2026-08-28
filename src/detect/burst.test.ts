import { describe, it, expect } from 'vitest';
import {
  burstScore,
  emptyAccountRatio,
  windowShare,
  BURST_WINDOW_MINUTES,
  EMPTY_MAX_FOLLOWERS,
} from './burst';
import { DEFAULT_SETTINGS } from '../types/domain';
import { API_PER_PAGE } from '../api/rate-budget';
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

  it('ちょうど既定の幅なら窓内に入れる', () => {
    // Arrange — 境界。<= か < かで結果が変わる
    const index: LikeIndex = {
      'example-liker-1': entry([record(1, BURST_WINDOW_MINUTES), record(2, BURST_WINDOW_MINUTES)]),
      'example-liker-2': entry([record(1, 1), record(2, 1)]),
    };
    // Act & Assert
    expect(burstScore(index, HIT)).toBe(1);
  });

  it('既定の幅を 1 分でも超えたら窓外', () => {
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

/**
 * 幅は Settings.burstWindowMinutes でユーザーが決める（Phase 9）。
 * 上の describe が引数を省略したまま全通過することが、既定引数の証拠になっている。
 */
describe('burstScore の可変な幅', () => {
  /** 90 分後に 2 件、5 分後に 2 件。60 分だと 0.5、120 分だと 1.0 になる */
  const INDEX: LikeIndex = {
    'example-liker-1': entry([record(1, 90), record(2, 90)]),
    'example-liker-2': entry([record(1, 5), record(2, 5)]),
  };

  it('幅を 120 分にすると 90 分後のいいねが窓内に入る', () => {
    // Arrange & Act & Assert
    expect(burstScore(INDEX, HIT, 120)).toBe(1);
  });

  it('幅が 60 分なら 90 分後は窓外', () => {
    expect(burstScore(INDEX, HIT, 60)).toBe(0.5);
  });

  it('幅を 30 分にすると 60 分後のいいねが窓外になる', () => {
    // Arrange — 60 分後が 2 件、5 分後が 2 件
    const index: LikeIndex = {
      'example-liker-1': entry([record(1, 60), record(2, 60)]),
      'example-liker-2': entry([record(1, 5), record(2, 5)]),
    };
    // Act & Assert — 既定（180 分）なら 1.0 だが、30 分では半分が落ちる
    expect(burstScore(index, HIT, 30)).toBe(0.5);
    expect(burstScore(index, HIT)).toBe(1);
  });

  it('省略すると BURST_WINDOW_MINUTES と同じ結果になる', () => {
    expect(burstScore(INDEX, HIT)).toBe(burstScore(INDEX, HIT, BURST_WINDOW_MINUTES));
  });

  it('既定値の出所は DEFAULT_SETTINGS（2 箇所に 60 と書かない）', () => {
    expect(BURST_WINDOW_MINUTES).toBe(DEFAULT_SETTINGS.burstWindowMinutes);
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

/**
 * 窓内占有率。**burstScore と分母が違う**のが要点。
 *
 *   burstScore  = クラスタの窓内いいね / クラスタのいいね総数
 *   windowShare = クラスタの窓内いいね / **その記事の窓内いいね総数**
 */
describe('windowShare', () => {
  /** 取りこぼしの検査があるので、総いいね数を必ず明示する */
  function withTotal(n: number, minutesAfterPost: number, total: number): LikeRecord {
    return record(n, minutesAfterPost, { itemTotalLikes: total });
  }

  it('クラスタ外の liker も分母に入る', () => {
    // Arrange — 記事 1・2 それぞれに 3 人（うちクラスタ 2 人）
    const index: LikeIndex = {
      'example-liker-1': entry([withTotal(1, 10, 3), withTotal(2, 10, 3)]),
      'example-liker-2': entry([withTotal(1, 10, 3), withTotal(2, 10, 3)]),
      'example-outsider': entry([withTotal(1, 10, 3), withTotal(2, 10, 3)]),
    };
    // Act & Assert — 窓内に居た 3 人のうちクラスタは 2 人（件数ではなく人数）
    expect(windowShare(index, HIT, 60)).toEqual({ cluster: 2, total: 3 });
  });

  it('幅を広げると一般票が分母に入って下がる', () => {
    // Arrange — 部外者は 10 時間後に押している（実測と同じ形: 一般の読者は後から来る）
    const index: LikeIndex = {
      'example-liker-1': entry([withTotal(1, 10, 3), withTotal(2, 10, 3)]),
      'example-liker-2': entry([withTotal(1, 10, 3), withTotal(2, 10, 3)]),
      'example-outsider': entry([withTotal(1, 600, 3), withTotal(2, 600, 3)]),
    };
    // Act & Assert — 60 分では 2/2、720 分では 2/3
    expect(windowShare(index, HIT, 60)).toEqual({ cluster: 2, total: 2 });
    expect(windowShare(index, HIT, 720)).toEqual({ cluster: 2, total: 3 });
  });

  it('取りこぼしている記事があれば測らない（null）', () => {
    // Arrange — 記事 1 の Total-Count は 5 だが、インデックスには 2 人しか居ない
    const index: LikeIndex = {
      'example-liker-1': entry([withTotal(1, 10, 5), withTotal(2, 10, 2)]),
      'example-liker-2': entry([withTotal(1, 10, 5), withTotal(2, 10, 2)]),
    };
    // Act & Assert — **部分的な分母は過大な占有率を出す**ので測定を放棄する
    expect(windowShare(index, HIT, 60)).toBeNull();
  });

  it('Total-Count が無くても、上限未満なら「全部取れた」と扱う', () => {
    // Arrange — この機能より前に取った古いレコードにはこのフィールドが無い。
    // **記事は再取得されない**（scanner の seen）ので、ここで救わないと
    // 蓄積済みの候補は永久に「測れません」のままになる
    const index: LikeIndex = {
      'example-liker-1': entry([record(1, 10), record(2, 10)]),
      'example-liker-2': entry([record(1, 10), record(2, 10)]),
    };
    // Act & Assert — per_page 未満しか無い = それが全部だった
    expect(windowShare(index, HIT, 60)).toEqual({ cluster: 2, total: 2 });
  });

  it('Total-Count が無く、ちょうど上限まで持っていれば測らない', () => {
    // Arrange — per_page ちょうどだと、切り詰められたのか偶然一致したのか
    // 区別できない。**分母が欠けたまま自信満々に出すより測らない方が無害**
    const index: LikeIndex = {};
    for (let i = 0; i < API_PER_PAGE; i += 1) {
      index[`example-liker-${String(i + 1)}`] = entry([record(1, 10), record(2, 10)]);
    }
    // Act & Assert
    expect(windowShare(index, HIT, 60)).toBeNull();
  });

  it('総数が食い違うときは大きい方で取りこぼしを判定する', () => {
    // Arrange — 再取得でいいねが増えた形。古い 2 を採ると「揃っている」と誤判定する
    const index: LikeIndex = {
      'example-liker-1': entry([withTotal(1, 10, 2), withTotal(2, 10, 2)]),
      'example-liker-2': entry([withTotal(1, 10, 4), withTotal(2, 10, 2)]),
    };
    // Act & Assert — 記事 1 は 2 件しか持っていないのに総数 4
    expect(windowShare(index, HIT, 60)).toBeNull();
  });

  it('窓内が空なら null ではなく 0 件として返す', () => {
    // **「測れない」と「測ったら空だった」は別物**
    const index: LikeIndex = {
      'example-liker-1': entry([withTotal(1, 600, 2), withTotal(2, 600, 2)]),
      'example-liker-2': entry([withTotal(1, 600, 2), withTotal(2, 600, 2)]),
    };
    expect(windowShare(index, HIT, 60)).toEqual({ cluster: 0, total: 0 });
  });

  it('根拠記事以外のいいねは分母にも分子にも入らない', () => {
    // Arrange — **部外者の唯一のいいねを根拠記事の外に置く。**クラスタ側の人に
    // 足しても、その人は根拠記事でも窓内なので、フィルタが効いているか判別できない
    const index: LikeIndex = {
      'example-liker-1': entry([withTotal(1, 10, 2), withTotal(2, 10, 2)]),
      'example-liker-2': entry([withTotal(1, 10, 2), withTotal(2, 10, 2)]),
      'example-outsider': entry([withTotal(9, 10, 1)]),
    };
    // Act & Assert
    expect(windowShare(index, HIT, 60)).toEqual({ cluster: 2, total: 2 });
  });

  /**
   * 100 件を超える記事は末尾から遡って取るので、**真ん中が欠けたまま
   * 「投稿から N 分後までは全部」**という形になる。「全部持っているか」では
   * 完全性を判定できず、そのままだと永久に測れない。
   */
  function tailFetched(n: number, minutesAfterPost: number, reach: number): LikeRecord {
    return record(n, minutesAfterPost, { itemTotalLikes: 250, itemCoveredMinutes: reach });
  }

  it('窓を覆っていれば、全部持っていなくても測れる', () => {
    // Arrange — 総数 250 のうち 2 人ぶんしか持っていないが、300 分後までは全部
    const index: LikeIndex = {
      'example-liker-1': entry([tailFetched(1, 10, 300), tailFetched(2, 10, 300)]),
      'example-liker-2': entry([tailFetched(1, 10, 300), tailFetched(2, 10, 300)]),
    };
    // Act & Assert — 180 分は 300 分の内側
    expect(windowShare(index, HIT, 180)).toEqual({ cluster: 2, total: 2 });
  });

  it('窓が覆った範囲を超えていれば測らない', () => {
    // Arrange — 同じデータでも 720 分は 300 分の外側。**そこは取りこぼしている**
    const index: LikeIndex = {
      'example-liker-1': entry([tailFetched(1, 10, 300), tailFetched(2, 10, 300)]),
      'example-liker-2': entry([tailFetched(1, 10, 300), tailFetched(2, 10, 300)]),
    };
    // Act & Assert
    expect(windowShare(index, HIT, 720)).toBeNull();
  });

  it('投稿より前のいいね（データ不整合）は分母からも除く', () => {
    // Arrange — **部外者の唯一のいいねを Δ<0 にする。**クラスタ側に置くと、
    // その人は別の記事で窓内に入るので、除外されたか判別できない。
    // **保持件数には数える**ので取りこぼし判定は通る（記事 1 は 3 人・総数 3）
    const index: LikeIndex = {
      'example-liker-1': entry([withTotal(1, 10, 3), withTotal(2, 10, 2)]),
      'example-liker-2': entry([withTotal(1, 10, 3), withTotal(2, 10, 2)]),
      'example-outsider': entry([withTotal(1, -10, 3)]),
    };
    // Act & Assert
    expect(windowShare(index, HIT, 60)).toEqual({ cluster: 2, total: 2 });
  });
});
