import { describe, it, expect } from 'vitest';
import {
  getToken,
  saveToken,
  clearToken,
  getRateLimitedUntil,
  saveRateLimit,
  getLikeIndex,
  saveLikeIndex,
  saveScanResult,
  getLastScanResult,
  getCandidates,
  saveCandidates,
} from './storage';
import type { Candidate, LikeIndex, ScanResult } from '../types/domain';

describe('getToken', () => {
  it('未設定なら null を返す', async () => {
    // Arrange — setup.ts が beforeEach でストアを新品に差し替える
    // Act
    const token = await getToken();
    // Assert
    expect(token).toBeNull();
  });

  it('保存したトークンを読み戻せる', async () => {
    // Arrange
    await saveToken('dummy-token-value');
    // Act
    const token = await getToken();
    // Assert
    expect(token).toBe('dummy-token-value');
  });

  it('空文字は未設定として扱う', async () => {
    await chrome.storage.local.set({ token: '' });
    expect(await getToken()).toBeNull();
  });

  it('clearToken の後は null に戻る', async () => {
    await saveToken('dummy-token-value');
    await clearToken();
    expect(await getToken()).toBeNull();
  });
});

/**
 * 429 の記録。単位は **Unix 秒**（Rate-Reset の単位）。ミリ秒と混同すると
 * Phase 6 の「あと N 分」が 1000 倍ずれる。
 */
describe('getRateLimitedUntil', () => {
  it('未保存なら null', async () => {
    // Act & Assert
    expect(await getRateLimitedUntil()).toBeNull();
  });

  it('保存した再開時刻を読み戻せる', async () => {
    // Arrange — 2026-08-19 の実測ヘッダーと同じ桁
    await saveRateLimit(1787104432);
    // Act & Assert
    expect(await getRateLimitedUntil()).toBe(1787104432);
  });

  it('null を渡すとキーごと消える（枠が回復したら止まっていない）', async () => {
    // Arrange
    await saveRateLimit(1787104432);
    // Act
    await saveRateLimit(null);
    // Assert
    expect(await getRateLimitedUntil()).toBeNull();
    expect(await chrome.storage.local.get(null)).not.toHaveProperty('rateLimitedUntil');
  });

  it('数値でない値が入っていても例外を投げず null を返す', async () => {
    // Arrange — storage が壊れているケース
    await chrome.storage.local.set({ rateLimitedUntil: 'soon' });
    // Act & Assert
    await expect(getRateLimitedUntil()).resolves.toBeNull();
  });
});

describe('getLikeIndex', () => {
  it('未保存なら空オブジェクトを返す', async () => {
    expect(await getLikeIndex()).toEqual({});
  });

  it('保存したインデックスを読み戻せる', async () => {
    // Arrange
    const index: LikeIndex = {
      'example-liker': {
        likes: [
          {
            itemId: '0123456789abcdef0123',
            authorHandle: 'example-author',
            likedAt: '2026-08-19T06:00:00+09:00',
            itemPostedAt: '2026-08-19T05:30:00+09:00',
          },
        ],
        itemsCount: 0,
        followersCount: 1,
        hasDescription: false,
      },
    };
    await saveLikeIndex(index);
    // Act
    const loaded = await getLikeIndex();
    // Assert
    expect(loaded).toEqual(index);
  });

  it('壊れた値が入っていても例外を投げず既定値を返す', async () => {
    // Arrange — 配列が入っているケース
    await chrome.storage.local.set({ likeIndex: ['broken'] });
    // Act & Assert
    await expect(getLikeIndex()).resolves.toEqual({});
  });
});

describe('saveScanResult', () => {
  it('結果を保存し lastScanAt に終了時刻が入る', async () => {
    // Arrange
    const result: ScanResult = {
      mode: 'light',
      newItemCount: 30,
      scannedItemCount: 30,
      likeRecordCount: 540,
      startedAt: '2026-08-19T05:01:00+09:00',
      finishedAt: '2026-08-19T05:03:00+09:00',
    };
    // Act
    await saveScanResult(result);
    // Assert
    expect(await getLastScanResult()).toEqual(result);
    const stored = await chrome.storage.local.get('lastScanAt');
    expect(stored).toEqual({ lastScanAt: '2026-08-19T05:03:00+09:00' });
  });

  it('未保存なら getLastScanResult は null', async () => {
    expect(await getLastScanResult()).toBeNull();
  });
});

/**
 * getLikeIndex は「配列なら壊れている」と判定するが、candidates は配列が正しい形。
 * 判定の向きが逆なので、同等のフェイルセーフが効いているかを別途固定する。
 */
describe('getCandidates', () => {
  /** 合成の候補。実アカウント名は使わない */
  const candidate: Candidate = {
    authorHandle: 'example-author-a',
    clusterAccounts: ['example-liker-1', 'example-liker-2'],
    sharedItemCount: 2,
    sharedItemIds: ['0123456789abcdef0001', '0123456789abcdef0002'],
    clusterSize: 2,
    burstScore: 0.75,
    emptyAccountRatio: 1,
    detectedAt: '2026-08-19T03:00:00.000Z',
    verdict: null,
  };

  it('未保存なら空配列を返す', async () => {
    // Arrange — setup.ts が beforeEach でストアを新品に差し替える
    // Act & Assert — undefined ではなく空配列（Phase 6 の UI が map できるように）
    expect(await getCandidates()).toEqual([]);
  });

  it('保存した候補を読み戻せる', async () => {
    // Arrange
    await saveCandidates([candidate]);
    // Act
    const loaded = await getCandidates();
    // Assert
    expect(loaded).toEqual([candidate]);
  });

  it('空配列を保存して読み戻せる（検出ゼロ件が「未保存」と区別できる）', async () => {
    await saveCandidates([candidate]);
    await saveCandidates([]);
    expect(await getCandidates()).toEqual([]);
  });

  it('配列でない値が入っていても例外を投げず空配列を返す', async () => {
    // Arrange — storage が壊れているケース
    await chrome.storage.local.set({ candidates: { broken: true } });
    // Act & Assert
    await expect(getCandidates()).resolves.toEqual([]);
  });

  it('null が入っていても空配列を返す', async () => {
    await chrome.storage.local.set({ candidates: null });
    await expect(getCandidates()).resolves.toEqual([]);
  });
});
