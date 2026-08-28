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
  describeEmpty,
  describeWindowShare,
  describeCoAuthors,
  partitionViews,
  describeFold,
  hasMutedInFold,
  describeWindow,
  windowIndexOf,
  BURST_WINDOW_CHOICES,
  requestMute,
} from './popup-state';
import type { CandidateView } from './popup-state';
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
    // 窓内のいいね 5 件中 4 件がこの顔ぶれ = 80%。
    // **burstScore(0.5) と別の値にしてある** — 取り違えたら文言テストが落ちる
    windowShare: { cluster: 4, total: 5 },
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
    await storage.saveSettings({
      ...DEFAULT_SETTINGS,
      minClusterSize: 8,
      minSharedItems: 3,
      lookbackDays: 5,
    });
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
      await applySettings(
        { ...DEFAULT_SETTINGS, minClusterSize: 5, minSharedItems: 2, lookbackDays: 3 },
        NOW,
      ),
    ).toHaveLength(1);
    expect(
      await applySettings(
        { ...DEFAULT_SETTINGS, minClusterSize: 20, minSharedItems: 2, lookbackDays: 3 },
        NOW,
      ),
    ).toEqual([]);
  });

  it('設定と候補を保存する', async () => {
    // Arrange
    await storage.saveLikeIndex(clusteredIndex(5));
    const settings = { ...DEFAULT_SETTINGS, minClusterSize: 5, minSharedItems: 2, lookbackDays: 3 };
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
      { ...DEFAULT_SETTINGS, minClusterSize: 5, minSharedItems: 2, lookbackDays: 3 },
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

  it('候補の行では解除の案内を繰り返さない（最終スキャンの下に常設した）', () => {
    // Arrange
    const record = { outcome: 'not-on-page' as const, at: AT, mutedAt: AT };
    // Act & Assert — 行ごとに同じ導線を出すと、候補の数だけ同じ文が並ぶ
    expect(describeMuteRecord(record)).not.toContain('ミュート設定');
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

/**
 * 折りたたみ（Phase 9）。**表示の設定であって判定ではない。**
 *
 * 既定は 'none'。視界から消す方向の変更なので、誤検知でミュートした
 * アカウントを再評価できなくする失敗（OQ-16）と同じ形を持つ。
 */
describe('partitionViews', () => {
  const AT = '2026-08-25T12:00:00.000Z';

  /** 未評価 / 妥当・ミュート成功 / 誤り の 3 件 */
  function views(): CandidateView[] {
    return toViews(
      [candidate('a'), candidate('b'), candidate('c')],
      { 'example-author-b': 'valid', 'example-author-c': 'false_positive' },
      { 'example-author-b': { outcome: 'muted' as const, at: AT, mutedAt: AT } },
    );
  }

  it('none なら 1 件も折りたたまない', () => {
    // Act
    const { open, folded } = partitionViews(views(), 'none');
    // Assert
    expect(open).toHaveLength(3);
    expect(folded).toEqual([]);
  });

  it('muted はミュートに成功したものだけを折りたたむ', () => {
    const { open, folded } = partitionViews(views(), 'muted');
    expect(folded.map((v) => v.candidate.authorHandle)).toEqual(['example-author-b']);
    expect(open).toHaveLength(2);
  });

  it('押し直して not-on-page になっても折りたたまれたまま', () => {
    // Arrange — ミュートすると記事がトレンドから消えるので、押し直すと必ずこうなる。
    // outcome で判定すると、押し直した瞬間に折りたたみから飛び出す
    const list = toViews(
      [candidate('b')],
      { 'example-author-b': 'valid' },
      { 'example-author-b': { outcome: 'not-on-page' as const, at: AT, mutedAt: AT } },
    );
    // Act & Assert
    expect(partitionViews(list, 'muted').folded).toHaveLength(1);
  });

  it('一度も成功していなければ muted では折りたたまない', () => {
    // Arrange — mutedAt が無い（試したが失敗した）
    const list = toViews(
      [candidate('b')],
      { 'example-author-b': 'valid' },
      { 'example-author-b': { outcome: 'not-on-page' as const, at: AT } },
    );
    // Act & Assert
    expect(partitionViews(list, 'muted').folded).toEqual([]);
  });

  it('valid は「妥当」だけを折りたたむ（「誤り」は一覧に戻る）', () => {
    const { open, folded } = partitionViews(views(), 'valid');
    expect(folded.map((v) => v.candidate.authorHandle)).toEqual(['example-author-b']);
    expect(open.map((v) => v.candidate.authorHandle)).toEqual([
      'example-author-a',
      'example-author-c',
    ]);
  });

  it('judged は妥当も誤りも折りたたむ', () => {
    const { open, folded } = partitionViews(views(), 'judged');
    expect(folded).toHaveLength(2);
    expect(open.map((v) => v.candidate.authorHandle)).toEqual(['example-author-a']);
  });

  it('順序を保つ（並べ替えは detector の責務）', () => {
    const { open } = partitionViews(views(), 'valid');
    expect(open[0]?.candidate.authorHandle).toBe('example-author-a');
  });

  it('空配列でも例外を投げない', () => {
    expect(partitionViews([], 'judged')).toEqual({ open: [], folded: [] });
  });
});

describe('describeFold', () => {
  it('none なら空文字（器ごと出さない）', () => {
    expect(describeFold('none', 3)).toBe('');
  });

  it('0 件なら空文字', () => {
    expect(describeFold('judged', 0)).toBe('');
  });

  it('対象ごとに言い分ける', () => {
    expect(describeFold('muted', 2)).toContain('ミュート済み');
    expect(describeFold('valid', 2)).toContain('妥当');
    expect(describeFold('judged', 2)).toContain('評価済み');
  });

  it('件数を出す', () => {
    expect(describeFold('judged', 7)).toContain('7');
  });
});

/**
 * 「誤り」を押しても Qiita 側のミュートは解除されない。
 * 折りたたみは視界から消す機能なので、解除の導線を必ず添える（OQ-16）。
 */
describe('hasMutedInFold', () => {
  const AT = '2026-08-25T12:00:00.000Z';

  it('ミュート済みが 1 件でもあれば true', () => {
    // Arrange
    const list = toViews(
      [candidate('b')],
      {},
      { 'example-author-b': { outcome: 'muted' as const, at: AT, mutedAt: AT } },
    );
    // Act & Assert
    expect(hasMutedInFold(list)).toBe(true);
  });

  it('押し直して not-on-page でも true（成功の事実は消えない）', () => {
    const list = toViews(
      [candidate('b')],
      {},
      { 'example-author-b': { outcome: 'not-on-page' as const, at: AT, mutedAt: AT } },
    );
    expect(hasMutedInFold(list)).toBe(true);
  });

  it('ミュート済みが 1 件も無ければ false（関係ない注意書きを常駐させない）', () => {
    const list = toViews([candidate('a')], { 'example-author-a': 'valid' });
    expect(hasMutedInFold(list)).toBe(false);
  });

  it('試したが成功していないだけなら false', () => {
    const list = toViews(
      [candidate('b')],
      {},
      { 'example-author-b': { outcome: 'no-trend-tab' as const, at: AT } },
    );
    expect(hasMutedInFold(list)).toBe(false);
  });

  it('空配列なら false', () => {
    expect(hasMutedInFold([])).toBe(false);
  });
});

/** 幅が可変になった以上、数字だけでは意味が読めない */
describe('describeWindowShare', () => {
  it('分母（窓内のいいね総数）と分子を実件数で出す', () => {
    // Arrange — フィクスチャは窓内 5 人中 4 人
    const text = describeWindowShare(candidate('a'), 180);
    // Act & Assert — **見出しと同じ「アカウント」単位で、分子/分母の形で書く**
    expect(text).toContain('4/5 アカウント (80%)');
  });

  it('幅を文言に出す', () => {
    expect(describeWindowShare(candidate('a'), 60)).toContain('60 分以内');
    expect(describeWindowShare(candidate('a'), 1440)).toContain('1 日以内');
  });

  it('分母がクラスタではなく記事だと読める形にする', () => {
    // **burstScore と取り違えると強さを誤って伝える。**
    // burstScore は 0.5 なので、それを使っていれば 50% が出る
    const text = describeWindowShare(candidate('a'), 180);
    expect(text).toContain('が同じメンバー');
    expect(text).not.toContain('50%');
  });

  it('「顔ぶれ」という語を使わない', () => {
    // **語感も判断に影響する。**断定しない（約束 6）は文言だけの規則ではない
    expect(describeWindowShare(candidate('a'), 180)).not.toContain('顔ぶれ');
    expect(describeCoAuthors(['example-author-b'])).not.toContain('顔ぶれ');
  });

  it('見出しと同じアカウント単位で数える（いいねの件数ではない）', () => {
    // **(アカウント × 記事) の組で数えると、3 記事とも押した人が 3 回数えられ、
    // 見出しの「N アカウント」と食い違う**（2026-08-25 のユーザー指摘）
    const text = describeWindowShare(candidate('a'), 180);
    expect(text).toContain('アカウント');
    expect(text).not.toContain('件');
  });

  it('どの記事の話かを行だけで読める', () => {
    // 見出しは「3 記事に重なった」と言っているので、この行にも範囲を書く
    expect(describeWindowShare(candidate('a'), 180)).toContain('該当記事の');
  });

  it('測れないときは 0% と言わない', () => {
    // **「測れない」と「測ったら 0 だった」は別物。**取り違えると
    // 条件を動かす方向が逆になる（適合率の分母 0 と同じ話）
    const text = describeWindowShare({ ...candidate('a'), windowShare: null }, 180);
    expect(text).toContain('測れません');
    expect(text).not.toContain('0%');
  });

  it('窓内に誰も居なければ「測れない」ではなく「まだいません」', () => {
    const empty = { ...candidate('a'), windowShare: { cluster: 0, total: 0 } };
    const text = describeWindowShare(empty, 180);
    expect(text).toContain('まだいません');
    expect(text).not.toContain('測れません');
  });

  it('保存済みの古い候補（フィールドが無い）でも落ちない', () => {
    // getCandidates は形を検証しない（`list as Candidate[]`）ので、
    // このフィールドを持たない候補が来る経路が実在する
    const legacy: Candidate = { ...candidate('a') };
    Reflect.deleteProperty(legacy, 'windowShare');
    expect(describeWindowShare(legacy, 180)).toContain('測れません');
  });

  it('端数は四捨五入する', () => {
    // 2/3 = 0.666… は 67%
    const twoThirds = { ...candidate('a'), windowShare: { cluster: 2, total: 3 } };
    expect(describeWindowShare(twoThirds, 180)).toContain('67%');
  });
});

/**
 * 空アカウント率は**画面に出さない**（2026-08-25 に削除）。
 *
 * 実測で、検出された 31 人の空率 61% に対し **同じ記事群の liker 全体が 54%**、
 * 集団の外側だけでも 50% あった。**比較相手を決めない割合は強さを誤って伝える。**
 * `Candidate.emptyAccountRatio` の記録は続けるので、同形の基準線が用意できたら
 * 戻せる。ここでは「出さない」ことだけを固定する。
 */
describe('空アカウント率', () => {
  it('占有率の文言に混ぜない', () => {
    const text = describeWindowShare(candidate('a'), 180);
    expect(text).not.toContain('プロフィール');
    expect(text).not.toContain('記事 0 本');
  });
});

describe('describeEmpty', () => {
  it('蓄積が無ければトレンドページを開くよう案内する', () => {
    expect(describeEmpty(false)).toContain('トレンドページ');
  });

  it('蓄積があるのにゼロなら条件をゆるめるよう案内する', () => {
    expect(describeEmpty(true)).toContain('ゆるめる');
  });

  it('折りたたみの中に居るなら、条件をいじらせない', () => {
    // Arrange & Act
    const text = describeEmpty(true, 2);
    // Assert — 何もしていない人に条件を触らせるのは的外れ
    expect(text).toContain('折りたたみ');
    expect(text).not.toContain('ゆるめる');
  });
});

describe('loadPopupState の折りたたみ設定', () => {
  it('未設定なら none', async () => {
    await expect(loadPopupState(NOW)).resolves.toHaveProperty('foldTarget', 'none');
  });

  it('保存済みの値を返す', async () => {
    await storage.saveFoldTarget('valid');
    await expect(loadPopupState(NOW)).resolves.toHaveProperty('foldTarget', 'valid');
  });
});

/**
 * 「投稿から何分以内」の目盛り（Phase 9）。
 *
 * 分は等間隔に並ばない（60 → 2880）ので、スライダーは **添字** を持つ。
 * 分を value にすると 60 と 120 のあいだに 59 個の無意味な目盛りができる。
 */
describe('BURST_WINDOW_CHOICES', () => {
  it('昇順で重複が無い', () => {
    // Act & Assert — 添字と分の対応が一意でないと windowIndexOf が壊れる
    for (let i = 1; i < BURST_WINDOW_CHOICES.length; i += 1) {
      expect(BURST_WINDOW_CHOICES[i]).toBeGreaterThan(BURST_WINDOW_CHOICES[i - 1] ?? 0);
    }
  });

  it('既定値が目盛りの上に乗っている', () => {
    // 乗っていないと、開いた直後のつまみが最も近い別の値を指す
    expect(BURST_WINDOW_CHOICES).toContain(DEFAULT_SETTINGS.burstWindowMinutes);
  });

  it('60 分から 2 日まで', () => {
    expect(BURST_WINDOW_CHOICES[0]).toBe(60);
    expect(BURST_WINDOW_CHOICES[BURST_WINDOW_CHOICES.length - 1]).toBe(60 * 24 * 2);
  });
});

describe('describeWindow', () => {
  it('1 日未満は分で言う', () => {
    expect(describeWindow(60)).toBe('60 分');
    expect(describeWindow(720)).toBe('720 分');
  });

  it('1 日以上は日で言う（「1440 分」は読めない）', () => {
    expect(describeWindow(1440)).toBe('1 日');
    expect(describeWindow(2880)).toBe('2 日');
  });

  it('割り切れない値は分のまま（嘘の「1 日」を出さない）', () => {
    expect(describeWindow(1500)).toBe('1500 分');
  });
});

describe('windowIndexOf', () => {
  it('目盛りの上の値はその添字', () => {
    BURST_WINDOW_CHOICES.forEach((minutes, index) => {
      expect(windowIndexOf(minutes)).toBe(index);
    });
  });

  it('目盛りに無い値は最も近いものに寄せる', () => {
    // Arrange — 選択肢を変えたときに、保存済みの値がどこにも無くなりうる
    // Act & Assert — 先頭へ倒すとユーザーの設定が黙って最短に変わる
    expect(windowIndexOf(100)).toBe(BURST_WINDOW_CHOICES.indexOf(120));
    expect(windowIndexOf(1300)).toBe(BURST_WINDOW_CHOICES.indexOf(1440));
  });

  it('範囲の外でも端に寄せる', () => {
    expect(windowIndexOf(1)).toBe(0);
    expect(windowIndexOf(999999)).toBe(BURST_WINDOW_CHOICES.length - 1);
  });
});
