import { describe, it, expect, vi } from 'vitest';
import {
  precisionOf,
  toViews,
  rateLimitNotice,
  loadPopupState,
  formatJst,
  applySettings,
  recordVerdict,
  describeMode,
  describeCall,
  describeMuteOutcome,
  describeMuteRecord,
  requestMute,
} from './popup-state';
import * as storage from '../../lib/storage';
import * as domain from '../../types/domain';
import { DEFAULT_SETTINGS } from '../../types/domain';
import { RATE_LIMIT_ANON, RATE_LIMIT_AUTH } from '../../api/rate-budget';
import type { Candidate, FeedbackLog, LikeIndex } from '../../types/domain';

/** 合成の候補。実アカウント名・実 item_id は使わない */
function candidate(suffix: string, clusterSize = 5): Candidate {
  return {
    authorHandle: `example-author-${suffix}`,
    clusterAccounts: Array.from(
      { length: clusterSize },
      (_, i) => `example-liker-${String(i + 1)}`,
    ),
    sharedItemCount: 2,
    sharedItemIds: [`0123456789abcdef000${suffix}`, `fedcba9876543210000${suffix}`],
    clusterSize,
    burstScore: 0.5,
    emptyAccountRatio: 0.25,
    detectedAt: '2026-08-20T03:00:00.000Z',
  };
}

/** 著者 1 人の 2 記事に count 人が揃ったインデックス */
function clusteredIndex(count: number): LikeIndex {
  const index: LikeIndex = {};
  for (let i = 0; i < count; i += 1) {
    index[`example-liker-${String(i + 1)}`] = {
      likes: ['0123456789abcdef0001', '0123456789abcdef0002'].map((itemId) => ({
        itemId,
        authorHandle: 'example-author-a',
        likedAt: '2026-08-20T02:00:00.000Z',
        itemPostedAt: '2026-08-20T01:00:00.000Z',
      })),
      itemsCount: 0,
      followersCount: 1,
      hasDescription: false,
    };
  }
  return index;
}

const NOW = new Date('2026-08-20T03:00:00.000Z');

describe('precisionOf', () => {
  it('未評価なら ratio は null（0% ではない）', () => {
    // Arrange & Act
    const precision = precisionOf({});
    // Assert — 「測ったら 0% だった」と「まだ測っていない」は別物
    expect(precision).toEqual({ valid: 0, falsePositive: 0, ratio: null });
  });

  it('妥当だけなら 1.0', () => {
    const feedback: FeedbackLog = { 'example-author-a': 'valid', 'example-author-b': 'valid' };
    expect(precisionOf(feedback).ratio).toBe(1);
  });

  it('混在なら妥当 / (妥当 + 誤り)', () => {
    const feedback: FeedbackLog = {
      'example-author-a': 'valid',
      'example-author-b': 'valid',
      'example-author-c': 'valid',
      'example-author-d': 'false_positive',
    };
    expect(precisionOf(feedback)).toEqual({ valid: 3, falsePositive: 1, ratio: 0.75 });
  });

  it('全部誤りなら 0（null ではない）', () => {
    // Arrange — 評価はしたが 1 件も妥当でなかった状態
    const feedback: FeedbackLog = { 'example-author-a': 'false_positive' };
    // Act & Assert
    expect(precisionOf(feedback).ratio).toBe(0);
  });
});

describe('toViews', () => {
  it('評価を候補に重ねる', () => {
    // Arrange
    const feedback: FeedbackLog = { 'example-author-1': 'valid' };
    // Act
    const views = toViews([candidate('1'), candidate('2')], feedback);
    // Assert
    expect(views[0]?.verdict).toBe('valid');
    expect(views[1]?.verdict).toBeNull();
  });

  it('根拠記事の URL を組み立てる', () => {
    // Act
    const [view] = toViews([candidate('1')], {});
    // Assert — Candidate は URL を持たないので handle と itemId から作る
    expect(view?.evidence).toEqual([
      {
        itemId: '0123456789abcdef0001',
        url: 'https://qiita.com/example-author-1/items/0123456789abcdef0001',
      },
      {
        itemId: 'fedcba98765432100001',
        url: 'https://qiita.com/example-author-1/items/fedcba98765432100001',
      },
    ]);
  });
});

describe('rateLimitNotice', () => {
  it('until が null なら案内しない', () => {
    expect(rateLimitNotice(null, NOW)).toBeNull();
  });

  it('すでに過ぎていれば案内しない', () => {
    const past = Math.floor(NOW.getTime() / 1000) - 1;
    expect(rateLimitNotice(past, NOW)).toBeNull();
  });

  it('残り分数を出す', () => {
    // Arrange — 42 分後（Unix 秒。ミリ秒ではない）
    const until = Math.floor(NOW.getTime() / 1000) + 42 * 60;
    // Act & Assert
    expect(rateLimitNotice(until, NOW)).toContain('42 分');
  });

  it('1 分未満は切り上げる（「あと 0 分」と出さない）', () => {
    const until = Math.floor(NOW.getTime() / 1000) + 30;
    expect(rateLimitNotice(until, NOW)).toContain('1 分');
  });
});

describe('loadPopupState', () => {
  it('未保存でも例外を投げず空の状態を返す', async () => {
    // Act
    const state = await loadPopupState(NOW);
    // Assert
    expect(state.views).toEqual([]);
    expect(state.precision.ratio).toBeNull();
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(state.rateLimitNotice).toBeNull();
    expect(state.lastScanAt).toBeNull();
  });

  it('保存済みの候補・評価・設定・最終スキャンを束ねて返す', async () => {
    // Arrange
    await storage.saveCandidates([candidate('1')]);
    await storage.saveVerdict('example-author-1', 'valid');
    await storage.saveSettings({ minClusterSize: 8, minSharedItems: 3, lookbackDays: 5 });
    await storage.saveScanResult({
      mode: 'light',
      newItemCount: 25,
      scannedItemCount: 25,
      likeRecordCount: 363,
      startedAt: '2026-08-20T02:59:00.000Z',
      finishedAt: '2026-08-20T03:00:00.000Z',
    });
    // Act
    const state = await loadPopupState(NOW);
    // Assert
    expect(state.views).toHaveLength(1);
    expect(state.views[0]?.verdict).toBe('valid');
    expect(state.precision.ratio).toBe(1);
    expect(state.settings.minClusterSize).toBe(8);
    expect(state.lastScanAt).toBe('2026-08-20T03:00:00.000Z');
  });

  it('429 中なら案内を載せる', async () => {
    // Arrange
    await storage.saveRateLimit(Math.floor(NOW.getTime() / 1000) + 600);
    // Act & Assert
    expect(await loadPopupState(NOW)).toHaveProperty(
      'rateLimitNotice',
      expect.stringContaining('10 分'),
    );
  });
});

/**
 * スライダーは storage.local の蓄積に対して判定をやり直すだけ。
 * ここで API を叩くと、「取得はトレンドページを開いたときだけ」という
 * 設計が UI 側から崩れる。
 */
describe('applySettings', () => {
  it('閾値を下げると候補が出て、上げると消える', async () => {
    // Arrange — 5 人が著者 a の 2 記事に揃っている
    await storage.saveLikeIndex(clusteredIndex(5));
    // Act & Assert
    expect(
      await applySettings({ minClusterSize: 5, minSharedItems: 2, lookbackDays: 3 }, NOW),
    ).toHaveLength(1);
    expect(
      await applySettings({ minClusterSize: 20, minSharedItems: 2, lookbackDays: 3 }, NOW),
    ).toEqual([]);
  });

  it('設定と候補を保存する', async () => {
    // Arrange
    await storage.saveLikeIndex(clusteredIndex(5));
    const settings = { minClusterSize: 5, minSharedItems: 2, lookbackDays: 3 };
    // Act
    const views = await applySettings(settings, NOW);
    // Assert — Phase 7 の DOM 非表示がこの candidates を読む
    expect(views).toHaveLength(1);
    expect(await storage.getSettings()).toEqual(settings);
    expect(await storage.getCandidates()).toHaveLength(1);
  });

  it('閾値を変えても評価は消えない', async () => {
    // Arrange — 評価済みの状態で閾値を動かす
    await storage.saveLikeIndex(clusteredIndex(5));
    await storage.saveVerdict('example-author-a', 'valid');
    // Act
    const views = await applySettings(
      { minClusterSize: 5, minSharedItems: 2, lookbackDays: 3 },
      NOW,
    );
    // Assert — verdict を Candidate に持たせると、この再検出で消える
    expect(views[0]?.verdict).toBe('valid');
    expect((await loadPopupState(NOW)).precision.ratio).toBe(1);
  });

  it('再検出は API を 1 本も叩かない', async () => {
    // Arrange
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await storage.saveLikeIndex(clusteredIndex(5));
    // Act
    await applySettings(DEFAULT_SETTINGS, NOW);
    // Assert — スライダーでレート枠を減らさない
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

/** 保存は UTC だが、読む人は JST で暮らしている */
describe('formatJst', () => {
  it('UTC の ISO 文字列を JST で表示する', () => {
    // Arrange — UTC 03:00 は JST 12:00
    // Act & Assert
    expect(formatJst('2026-08-20T03:00:00.000Z')).toBe('2026/08/20 12:00');
  });

  it('日付をまたぐ時刻も JST に直す', () => {
    // UTC 前日 17:44 は JST 翌日 02:44
    expect(formatJst('2026-08-17T17:44:41Z')).toBe('2026/08/18 02:44');
  });

  it('壊れた日時はそのまま返す（例外を投げない）', () => {
    expect(formatJst('not-a-date')).toBe('not-a-date');
  });
});
describe('recordVerdict', () => {
  it('判定を保存して更新後の適合率を返す', async () => {
    // Act
    const first = await recordVerdict('example-author-a', 'valid');
    const second = await recordVerdict('example-author-b', 'false_positive');
    // Assert
    expect(first.ratio).toBe(1);
    expect(second).toEqual({ valid: 1, falsePositive: 1, ratio: 0.5 });
  });

  it('同じ著者を評価し直すと上書きする（二重計上しない）', async () => {
    // Arrange
    await recordVerdict('example-author-a', 'valid');
    // Act — 記事を読み直して考えを変えた
    const precision = await recordVerdict('example-author-a', 'false_positive');
    // Assert
    expect(precision).toEqual({ valid: 0, falsePositive: 1, ratio: 0 });
  });
});

/**
 * ポップアップに裸のボタンだけ置くと「なぜ設定するのか」が伝わらない。
 * 枠の数値は rate-budget の定数から作る（UI に直書きしない）。
 */
describe('describeMode', () => {
  it('未設定ならライトモードと、設定して得られるものを出す', () => {
    // Act
    const copy = describeMode(false);
    // Assert
    expect(copy.title).toBe('ライトモードで動作中');
    expect(copy.detail).toContain('著者の過去記事');
    expect(copy.detail).toContain(`${String(RATE_LIMIT_ANON)} → ${String(RATE_LIMIT_AUTH)}`);
    expect(copy.action).toBe('トークンを設定する');
  });

  it('設定済みならフルモードと表示し、操作の文言も変える', () => {
    const copy = describeMode(true);
    expect(copy.title).toBe('フルモードで動作中');
    expect(copy.detail).toContain(String(RATE_LIMIT_AUTH));
    expect(copy.action).toBe('トークンを変更する');
  });

  it('件数を「30 件」と断定しない（実際は表示件数に依存する）', () => {
    // ミュート済みの記事はトレンドに出ないため、実測では 25 件だった
    expect(describeMode(false).detail).not.toContain('30 件');
    expect(describeMode(true).detail).not.toContain('30 件');
  });
});

describe('loadPopupState のトークン状態', () => {
  it('未設定なら hasToken は false', async () => {
    expect((await loadPopupState(NOW)).hasToken).toBe(false);
  });

  it('保存済みなら true（生のトークンは状態に載せない）', async () => {
    // Arrange
    await storage.saveToken('dummy-token-value');
    // Act
    const state = await loadPopupState(NOW);
    // Assert
    expect(state.hasToken).toBe(true);
    expect(JSON.stringify(state)).not.toContain('dummy-token-value');
  });
});

/**
 * 適合率はユーザーが押さない限り永久に出ない。
 * 数字だけ並べても、何を求められているかは伝わらない。
 */
describe('describeCall', () => {
  const view = (verdict: 'valid' | 'false_positive' | null) => ({
    ...toViews([candidate('1')], {})[0]!,
    verdict,
  });

  it('候補ゼロなら何も言わない（別の案内が出る）', () => {
    expect(describeCall([], { valid: 0, falsePositive: 0, ratio: null })).toBe('');
  });

  it('未評価なら「何を判断するのか」まで書く', () => {
    // Act
    const call = describeCall([view(null)], { valid: 0, falsePositive: 0, ratio: null });
    // Assert — 評価対象は検出そのもの。「妥当 / 誤り」だけでは何を訊かれているか分からない
    expect(call).toContain('この検出が当たっているか');
    expect(call).toContain('根拠の記事');
    expect(call).toContain('妥当');
  });

  it('著者を断定する語を使わない（設計上の約束 6）', () => {
    const call = describeCall([view(null)], { valid: 0, falsePositive: 0, ratio: null });
    for (const word of ['不正', 'スパム', '業者', 'クロ']) {
      expect(call).not.toContain(word);
    }
  });

  it('評価の途中なら残りの件数を出す', () => {
    const call = describeCall([view('valid'), view(null), view(null)], {
      valid: 1,
      falsePositive: 0,
      ratio: 1,
    });
    expect(call).toBe('未評価があと 2 件あります。');
  });

  it('すべて評価済みならそう伝える', () => {
    const call = describeCall([view('valid'), view('false_positive')], {
      valid: 1,
      falsePositive: 1,
      ratio: 0.5,
    });
    expect(call).toBe('この一覧はすべて評価済みです。');
  });
});

/**
 * ミュートの結果の文言。**断定しない**（設計上の約束 6）。
 * menu-unavailable は「既にミュート済み」と「Qiita の変更」の両方を含むので、
 * 見分けられないことを隠さずに書く。
 */
describe('describeMuteOutcome', () => {
  it('すべての結果に文言を返す', () => {
    // Arrange — 型に足した値の文言を書き忘れると、UI が空欄になる
    const { MUTE_OUTCOMES } = domain;
    // Act & Assert
    for (const outcome of MUTE_OUTCOMES) {
      expect(describeMuteOutcome(outcome).length).toBeGreaterThan(0);
    }
  });

  it('「不正」「スパム」と断定しない', () => {
    const { MUTE_OUTCOMES } = domain;
    const texts = MUTE_OUTCOMES.map((outcome) => describeMuteOutcome(outcome));
    expect(texts.filter((text) => /不正|スパム|悪質/.test(text))).toEqual([]);
  });

  it('既にミュート済みの可能性を隠さずに書く', () => {
    // 見分けようとすると解除の文言を実装に持ち込むことになり、押す経路ができる
    expect(describeMuteOutcome('menu-unavailable')).toContain('既にミュート済み');
  });
});

describe('requestMute', () => {
  const NOW = new Date('2026-08-24T12:00:00.000Z');

  function tab(id: number, url: string, active = false): chrome.tabs.Tab {
    return { id, url, active } as unknown as chrome.tabs.Tab;
  }

  function tabsQueryMock() {
    // @types/chrome の query はオーバーロードを複数持つ。ここだけ型を黙らせる
    return vi.mocked(chrome.tabs.query) as unknown as {
      mockResolvedValue: (value: chrome.tabs.Tab[]) => void;
    };
  }

  function sendMessageMock() {
    return vi.mocked(chrome.tabs.sendMessage) as unknown as {
      mockResolvedValue: (value: unknown) => void;
      mockRejectedValue: (value: unknown) => void;
      mock: { calls: unknown[][] };
    };
  }

  it('トレンドタブが無ければ no-trend-tab を記録し、送らない', async () => {
    // Arrange
    tabsQueryMock().mockResolvedValue([]);
    // Act
    const log = await requestMute('example-author-a', NOW);
    // Assert
    expect(log['example-author-a']).toEqual({
      outcome: 'no-trend-tab',
      at: '2026-08-24T12:00:00.000Z',
    });
    expect(sendMessageMock().mock.calls).toHaveLength(0);
  });

  it('アクティブなトレンドタブを優先する', async () => {
    // Arrange — ユーザーが見ている画面で操作が起きる方が分かりやすい
    tabsQueryMock().mockResolvedValue([
      tab(1, 'https://qiita.com/'),
      tab(2, 'https://qiita.com/trend', true),
    ]);
    sendMessageMock().mockResolvedValue({
      type: 'MUTE_RESULT',
      handle: 'example-author-a',
      outcome: 'muted',
    });
    // Act
    await requestMute('example-author-a', NOW);
    // Assert
    expect(sendMessageMock().mock.calls[0]?.[0]).toBe(2);
  });

  it('応答の handle が違えば unreachable にする', async () => {
    // Arrange — 別の依頼の応答を取り違えない
    tabsQueryMock().mockResolvedValue([tab(1, 'https://qiita.com/trend')]);
    sendMessageMock().mockResolvedValue({
      type: 'MUTE_RESULT',
      handle: 'example-author-b',
      outcome: 'muted',
    });
    // Act
    const log = await requestMute('example-author-a', NOW);
    // Assert
    expect(log['example-author-a']?.outcome).toBe('unreachable');
  });

  it('知らない outcome が返っても通さない', async () => {
    tabsQueryMock().mockResolvedValue([tab(1, 'https://qiita.com/trend')]);
    sendMessageMock().mockResolvedValue({
      type: 'MUTE_RESULT',
      handle: 'example-author-a',
      outcome: 'something-else',
    });
    const log = await requestMute('example-author-a', NOW);
    expect(log['example-author-a']?.outcome).toBe('unreachable');
  });

  it('届かなければ unreachable を記録し、例外を漏らさない', async () => {
    // Arrange — 拡張をリロードすると content script が孤児になる
    tabsQueryMock().mockResolvedValue([tab(1, 'https://qiita.com/trend')]);
    sendMessageMock().mockRejectedValue(new Error('Receiving end does not exist'));
    // Act & Assert
    await expect(requestMute('example-author-a', NOW)).resolves.toEqual({
      'example-author-a': { outcome: 'unreachable', at: '2026-08-24T12:00:00.000Z' },
    });
  });

  it('解析できない URL のタブは対象外にし、例外を投げない', async () => {
    // Arrange — スキームが無いと new URL が throw する
    tabsQueryMock().mockResolvedValue([tab(1, 'qiita.com/trend', true)]);
    // Act & Assert
    const log = await requestMute('example-author-a', NOW);
    expect(log['example-author-a']?.outcome).toBe('no-trend-tab');
  });

  it('記事ページのタブには送らない', async () => {
    // Arrange — content script は qiita.com 全体に注入されている
    tabsQueryMock().mockResolvedValue([
      tab(1, 'https://qiita.com/example-author-a/items/0123456789abcdef0001', true),
    ]);
    // Act
    const log = await requestMute('example-author-a', NOW);
    // Assert
    expect(log['example-author-a']?.outcome).toBe('no-trend-tab');
    expect(sendMessageMock().mock.calls).toHaveLength(0);
  });

  it('結果を storage に残す（開き直しても読める）', async () => {
    tabsQueryMock().mockResolvedValue([]);
    await requestMute('example-author-a', NOW);
    await expect(storage.getMuteLog()).resolves.toEqual({
      'example-author-a': { outcome: 'no-trend-tab', at: '2026-08-24T12:00:00.000Z' },
    });
  });
});

describe('toViews のミュート結果', () => {
  it('記録があれば重ねる', () => {
    const log = {
      'example-author-a': { outcome: 'muted' as const, at: '2026-08-24T12:00:00.000Z' },
    };
    const [view] = toViews([candidate('a')], {}, log);
    expect(view?.mute?.outcome).toBe('muted');
  });

  it('記録が無ければ null（「まだ試していない」と「失敗した」を区別する）', () => {
    const [view] = toViews([candidate('a')], {});
    expect(view?.mute).toBeNull();
  });
});

/**
 * ★ 2026-08-24 の実機で見つかった文言の誤りの番人。
 *
 * ミュートすると Qiita がその著者の記事をトレンドから外す。そのあと同じ候補で
 * 「妥当」を押し直すと not-on-page になるが、outcome だけを見て
 * 「次に出てきたときに押し直してください」と案内していた。
 * ミュート済みの著者はもう出てこないので、起こり得ないことを促していた。
 */
describe('describeMuteRecord', () => {
  const AT = '2026-08-24T12:00:00.000Z';

  it('成功の記録があれば、not-on-page でも「ミュート済み」と言う', () => {
    // Arrange — ミュートしたあと押し直した状態
    const record = { outcome: 'not-on-page' as const, at: AT, mutedAt: AT };
    // Act
    const text = describeMuteRecord(record);
    // Assert
    expect(text).toContain('ミュート済み');
    expect(text).not.toContain('押し直して');
  });

  it('成功の記録があれば、menu-unavailable でも言い切る', () => {
    // Arrange — 推測混じりの「〜か、画面構造が変わった可能性」にしない
    const record = { outcome: 'menu-unavailable' as const, at: AT, mutedAt: AT };
    // Act & Assert
    expect(describeMuteRecord(record)).toContain('ミュート済み');
    expect(describeMuteRecord(record)).not.toContain('画面構造');
  });

  it('成功の記録が無ければ、従来どおり押し直しを促す', () => {
    // Arrange — 一度も成功していない
    const record = { outcome: 'not-on-page' as const, at: AT };
    // Act & Assert
    expect(describeMuteRecord(record)).toContain('押し直して');
  });

  it('成功そのものは成功の文言のまま', () => {
    const record = { outcome: 'muted' as const, at: AT, mutedAt: AT };
    expect(describeMuteRecord(record)).toBe(describeMuteOutcome('muted'));
  });

  it('成功の記録があっても、届かなかったときは押し直しを促す', () => {
    // Arrange — unreachable は再試行で直る類の失敗
    const record = { outcome: 'unreachable' as const, at: AT, mutedAt: AT };
    // Act & Assert
    expect(describeMuteRecord(record)).toBe(describeMuteOutcome('unreachable'));
  });
});
