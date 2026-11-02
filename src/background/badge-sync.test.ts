import { describe, it, expect, vi, beforeEach } from 'vitest';
import { countShownCandidates, refreshBadge, syncBadge } from './badge-sync';
import {
  recordMuteOutcome,
  saveCandidates,
  saveRateLimit,
  saveTrendSnapshot,
} from '../lib/storage';
import type { Candidate, MuteLog } from '../types/domain';

/** 合成の候補。実アカウント名・実 item_id は使わない */
function candidate(suffix: string): Candidate {
  return {
    authorHandle: `example-author-${suffix}`,
    clusterAccounts: ['example-liker-1', 'example-liker-2'],
    sharedItemCount: 2,
    sharedItemIds: [`0123456789abcdef000${suffix}`],
    clusterSize: 2,
    burstScore: 0.5,
    emptyAccountRatio: 0,
    windowShare: { cluster: 2, total: 2 },
    detectedAt: '2026-11-02T03:00:00.000Z',
  };
}

const AT = '2026-11-02T12:53:00.000Z';
const NOW = new Date('2026-11-02T13:00:00.000Z');

function badgeMock() {
  return vi.mocked(chrome.action.setBadgeText as (...args: unknown[]) => unknown);
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * バッジはポップアップの一覧（popup-state の toShownViews）と**同じ件数**を出す。
 * 規則は lib/visibility の isHiddenAsOffTrend を共有している。
 */
describe('countShownCandidates', () => {
  it('★ スナップショットが無ければ全件を数える（未確認を不在と読み替えない）', () => {
    expect(countShownCandidates([candidate('a'), candidate('b')], {}, null)).toBe(2);
  });

  it('スナップショットに居ない著者は数えない', () => {
    const snapshot = { authors: ['example-author-a'], at: AT };
    expect(countShownCandidates([candidate('a'), candidate('b')], {}, snapshot)).toBe(1);
  });

  it('★ ミュート済みと確認できた著者は、居なくても数える', () => {
    const muteLog: MuteLog = { 'example-author-b': { outcome: 'muted', at: AT, mutedAt: AT } };
    const snapshot = { authors: ['example-author-a'], at: AT };
    expect(countShownCandidates([candidate('a'), candidate('b')], muteLog, snapshot)).toBe(2);
  });

  it('★ ミュートを試しただけで確認できていない著者は、居なければ数えない', () => {
    // Arrange — 一覧はこの著者を出さない。数えると「一覧 1 件・バッジ 2」に戻る
    const muteLog: MuteLog = { 'example-author-b': { outcome: 'not-on-page', at: AT } };
    const snapshot = { authors: ['example-author-a'], at: AT };
    // Act & Assert
    expect(countShownCandidates([candidate('a'), candidate('b')], muteLog, snapshot)).toBe(1);
  });
});

describe('syncBadge', () => {
  it('保存済みの候補・ミュート記録・スナップショットから数える', async () => {
    // Arrange
    await saveCandidates([candidate('a'), candidate('b'), candidate('c')]);
    await saveTrendSnapshot(['example-author-a'], NOW);
    await recordMuteOutcome('example-author-b', 'muted', NOW);
    // Act
    await syncBadge(false);
    // Assert — a はトレンドに居る、b はミュート済み、c は外れる
    expect(badgeMock()).toHaveBeenCalledWith({ text: '2' });
  });

  it('429 中は記号にする', async () => {
    await saveCandidates([candidate('a')]);
    await syncBadge(true);
    expect(badgeMock()).toHaveBeenCalledWith({ text: '!' });
  });
});

describe('refreshBadge', () => {
  it('429 の記録がまだ有効なら記号にする', async () => {
    await saveCandidates([candidate('a')]);
    await saveRateLimit(Math.floor(NOW.getTime() / 1000) + 600);
    await refreshBadge(NOW);
    expect(badgeMock()).toHaveBeenCalledWith({ text: '!' });
  });

  it('429 の記録が過ぎていれば件数を出す', async () => {
    await saveCandidates([candidate('a')]);
    await saveRateLimit(Math.floor(NOW.getTime() / 1000) - 1);
    await refreshBadge(NOW);
    expect(badgeMock()).toHaveBeenCalledWith({ text: '1' });
  });
});
