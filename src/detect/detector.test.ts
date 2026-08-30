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

/** いいね者の名前を差し替える。別グループを作るために使う */
function renameLikers(index: LikeIndex, prefix: string): LikeIndex {
  const renamed: LikeIndex = {};
  for (const [handle, entry] of Object.entries(index)) {
    renamed[handle.replace('example-liker', prefix)] = entry;
  }
  return renamed;
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
    // Arrange — lookbackDays 7 に対して 8 日前の記事
    const index = cluster({
      author: 'example-author-a',
      items: [1, 2],
      accounts: 5,
      postedHoursAgo: 24 * 8,
    });
    // Act & Assert
    expect(detectCandidates(index, DEFAULT_SETTINGS, NOW)).toEqual([]);
  });

  /**
   * フルモードが辿る過去記事は定義上「過去」で、窓が短いとここで落ちる。
   * 既定が 3 日だったとき、**89 件のいいねを取得して判定に 0 件しか
   * 使っていなかった**（2026-08-23 実測）。既定を 7 日にした番人。
   */
  it('6 日前の記事は判定に入る（フルモードの過去記事を捨てない）', () => {
    // Arrange
    const index = cluster({
      author: 'example-author-a',
      items: [1, 2],
      accounts: 5,
      postedHoursAgo: 24 * 6,
    });
    // Act & Assert
    expect(detectCandidates(index, DEFAULT_SETTINGS, NOW)).toHaveLength(1);
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

/**
 * 著者をまたぐ共起（Phase 5b-2）。
 *
 * cluster.ts は著者ごとに閉じているので、記事が 1 本しかない著者は
 * 手順 1 で必ず落ちる。実測（2026-08-23）では、同じ 17 人が 2 人の著者の
 * 記事に揃って現れていた。
 */
describe('detectCandidates の著者をまたぐ共起', () => {
  /** A は 2 本（著者内でも成立）、B は 1 本（著者間でしか成立しない） */
  function twoAuthors(): LikeIndex {
    return mergeIndexes(
      cluster({ author: 'example-author-a', items: [1, 2], accounts: 5 }),
      cluster({ author: 'example-author-b', items: [3], accounts: 5 }),
    );
  }

  it('記事 1 本の著者も候補になる', () => {
    // Act
    const candidates = detectCandidates(twoAuthors(), DEFAULT_SETTINGS, NOW);
    // Assert — 著者内の判定だけなら B は永久に出ない
    const b = candidates.find((c) => c.authorHandle === 'example-author-b');
    expect(b).toBeDefined();
    expect(b?.sharedItemCount).toBe(1);
  });

  it('両方の判定で成立した著者は 1 件にまとまる', () => {
    // Arrange & Act — A は著者内（2 本）でも著者間（B との重なり）でも成立する
    const candidates = detectCandidates(twoAuthors(), DEFAULT_SETTINGS, NOW);
    // Assert — 2 件出ると同じ著者に 2 回評価を押させ、適合率の分母が壊れる
    expect(candidates.filter((c) => c.authorHandle === 'example-author-a')).toHaveLength(1);
    expect(candidates).toHaveLength(2);
  });

  it('マージ後の sharedItemIds は和集合になる', () => {
    // Act
    const candidates = detectCandidates(twoAuthors(), DEFAULT_SETTINGS, NOW);
    // Assert — A の 2 本が両方残る（著者間の判定は 1 本しか持たない）
    const a = candidates.find((c) => c.authorHandle === 'example-author-a');
    expect(a?.sharedItemIds).toEqual([itemId(1), itemId(2)]);
  });

  it('coAuthors に相手の著者が入る', () => {
    // Act
    const candidates = detectCandidates(twoAuthors(), DEFAULT_SETTINGS, NOW);
    // Assert — 根拠記事は自分のぶんしか持たないので、UI はここで他を示す
    const b = candidates.find((c) => c.authorHandle === 'example-author-b');
    expect(b?.coAuthors).toEqual(['example-author-a']);
  });

  it('coAuthors に自分は入らない', () => {
    const candidates = detectCandidates(twoAuthors(), DEFAULT_SETTINGS, NOW);
    for (const candidate of candidates) {
      expect(candidate.coAuthors ?? []).not.toContain(candidate.authorHandle);
    }
  });

  it('著者内クラスタだけなら coAuthors を持たない', () => {
    // Arrange — 1 人の著者しかいない
    const index = cluster({ author: 'example-author-a', items: [1, 2], accounts: 5 });
    // Act
    const [candidate] = detectCandidates(index, DEFAULT_SETTINGS, NOW);
    // Assert — 空配列ではなく未定義（UI が行ごと出さないため）
    expect(candidate?.coAuthors).toBeUndefined();
  });

  it('顔ぶれが違う著者どうしは結び付けない', () => {
    // Arrange — 別々の 5 人がそれぞれ別の著者を押している
    const index = mergeIndexes(
      cluster({ author: 'example-author-a', items: [1, 2], accounts: 5 }),
      renameLikers(cluster({ author: 'example-author-c', items: [4, 5], accounts: 5 }), 'other'),
    );
    // Act
    const candidates = detectCandidates(index, DEFAULT_SETTINGS, NOW);
    // Assert — どちらも著者内で成立するが、互いの coAuthors にはならない
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) expect(candidate.coAuthors).toBeUndefined();
  });
});

/**
 * 連結成分の分離が detector まで届いているか。
 * **orch-review の HIGH 指摘（2026-08-24）の番人。**
 */
describe('detectCandidates の連結成分', () => {
  /** 組織 X は全員が空アカウント、組織 Y は全員が中身のあるアカウント */
  function twoRings(): LikeIndex {
    return mergeIndexes(
      cluster({ author: 'example-author-a', items: [1], accounts: 5 }),
      cluster({ author: 'example-author-b', items: [2], accounts: 5 }),
      renameLikers(
        cluster({ author: 'example-author-c', items: [3], accounts: 5, empty: false }),
        'other',
      ),
      renameLikers(
        cluster({ author: 'example-author-d', items: [4], accounts: 5, empty: false }),
        'other',
      ),
    );
  }

  it('別の組織のアカウントで emptyAccountRatio が薄まらない', () => {
    // Act
    const candidates = detectCandidates(twoRings(), DEFAULT_SETTINGS, NOW);
    // Assert — 混ざると 1.0 が 0.5 に薄まり、指標として機能しなくなる
    const a = candidates.find((c) => c.authorHandle === 'example-author-a');
    expect(a?.emptyAccountRatio).toBe(1);
  });

  it('別の組織のアカウントで clusterSize が膨らまない', () => {
    // Act
    const candidates = detectCandidates(twoRings(), DEFAULT_SETTINGS, NOW);
    // Assert — clusterSize は並び順の主キー。膨らむと順位が狂う
    const a = candidates.find((c) => c.authorHandle === 'example-author-a');
    expect(a?.clusterSize).toBe(5);
  });

  it('別の組織の著者を coAuthors に入れない', () => {
    // Act
    const candidates = detectCandidates(twoRings(), DEFAULT_SETTINGS, NOW);
    // Assert — UI が事実でないことを述べる経路を塞ぐ
    const a = candidates.find((c) => c.authorHandle === 'example-author-a');
    expect(a?.coAuthors).toEqual(['example-author-b']);
  });

  it('独立した 2 組織の 4 著者すべてが候補になる', () => {
    expect(detectCandidates(twoRings(), DEFAULT_SETTINGS, NOW)).toHaveLength(4);
  });
});

/**
 * 投稿直後の幅（burstWindowMinutes）は Phase 9 でユーザーが決めるようになった。
 *
 * **下限（絞り込み）は作らない。**いつ押すかを握っているのは攻撃側なので、
 * 下限を設ければ時刻をずらすだけで候補から消え、しかも消えたことは
 * ユーザーに見えない。ここは「絞らないこと」を固定する番人でもある。
 *
 * **既定は 180 分**（60 分から変えた）。**候補の件数は変わらない**が、
 * スコアの表示と並び順のタイブレークは変わる。上の describe 群が
 * DEFAULT_SETTINGS のまま通ることは「件数が変わらない」ことの証拠であって、
 * 「何も変わらない」ことの証拠ではない。
 */
describe('detectCandidates の投稿直後の幅', () => {
  /** 全員が投稿から minutes 後に一斉いいね */
  function likedAfter(minutes: number): LikeIndex {
    return cluster({
      author: 'example-author-a',
      items: [1, 2],
      accounts: 5,
      burstMinutes: minutes,
    });
  }

  it('burstScore が 0 でも候補から外さない', () => {
    // Arrange — 投稿から 10 時間後。**手口を知って時刻をずらした形**
    const index = likedAfter(600);
    // Act
    const candidates = detectCandidates(index, DEFAULT_SETTINGS, NOW);
    // Assert — ここで絞ると、ずらした相手だけが見えなくなる
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.burstScore).toBe(0);
  });

  it('幅を変えても候補の件数は変わらない', () => {
    // Arrange — 300 分後。既定（180 分）では窓外、360 分では窓内
    const index = likedAfter(300);
    // Act & Assert
    expect(detectCandidates(index, DEFAULT_SETTINGS, NOW)).toHaveLength(1);
    expect(
      detectCandidates(index, { ...DEFAULT_SETTINGS, burstWindowMinutes: 360 }, NOW),
    ).toHaveLength(1);
  });

  it('幅を広げると burstScore が上がる（ユーザーが遅延に気づく手がかり）', () => {
    // Arrange — 既定（180 分）で 0.00 の著者が 360 分で 1.00 になれば、
    // いいねの時刻がずらされている
    const index = likedAfter(300);
    // Act
    const narrow = detectCandidates(index, DEFAULT_SETTINGS, NOW);
    const wide = detectCandidates(index, { ...DEFAULT_SETTINGS, burstWindowMinutes: 360 }, NOW);
    // Assert
    expect(narrow[0]?.burstScore).toBe(0);
    expect(wide[0]?.burstScore).toBe(1);
  });

  it('幅を狭めると burstScore が下がる', () => {
    const index = likedAfter(45);
    expect(detectCandidates(index, DEFAULT_SETTINGS, NOW)[0]?.burstScore).toBe(1);
    expect(
      detectCandidates(index, { ...DEFAULT_SETTINGS, burstWindowMinutes: 30 }, NOW)[0]?.burstScore,
    ).toBe(0);
  });
});
