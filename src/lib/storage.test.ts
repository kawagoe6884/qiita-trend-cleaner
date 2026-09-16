import { describe, it, expect, vi } from 'vitest';
import * as storage from './storage';

/**
 * chrome API のモックを取り出す。メソッドを直接渡すと unbound-method に
 * 引っかかるため、持ち主とキーで受け取る（service-worker.test.ts と同じ手）。
 */
function mockOf<T extends object, K extends keyof T>(owner: T, key: K) {
  return vi.mocked(owner[key] as (...args: unknown[]) => unknown);
}
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
  getSettings,
  saveSettings,
  getFeedback,
  saveVerdict,
  getAuthorVisits,
  saveAuthorVisits,
} from './storage';
import { DEFAULT_SETTINGS } from '../types/domain';
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
    // null = 測れない。storage は形を検証しないので、往復して壊れないことだけ見る
    windowShare: null,
    detectedAt: '2026-08-19T03:00:00.000Z',
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

/**
 * 閾値は sync に置く唯一のデータ。壊れた値を通すと findClusters の比較が
 * すべて false になり、候補が黙ってゼロになる。
 */
describe('getSettings', () => {
  it('未保存なら既定値', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('保存した設定を読み戻せる', async () => {
    const settings = {
      minClusterSize: 8,
      minSharedItems: 3,
      lookbackDays: 5,
      burstWindowMinutes: 180,
    };
    await saveSettings(settings);
    expect(await getSettings()).toEqual(settings);
  });

  it('local ではなく sync に書く', async () => {
    // Arrange — インデックスは 10 MB 級なので local、設定だけが sync
    await saveSettings(DEFAULT_SETTINGS);
    // Act & Assert
    expect(await chrome.storage.sync.get('settings')).toHaveProperty('settings');
    expect(await chrome.storage.local.get('settings')).toEqual({});
  });

  it('壊れた項目だけを既定値に倒す（他の項目は活かす）', async () => {
    // Arrange — 数値でない値が 1 つ混ざった状態
    await chrome.storage.sync.set({
      settings: { minClusterSize: '8', minSharedItems: 3, lookbackDays: 5 },
    });
    // Act & Assert — 全部捨てると、あとで項目を足したとき既存設定を巻き添えにする。
    // **Phase 9 で項目が 1 つ増えたが、既存 3 項目の扱いは変わっていない**
    expect(await getSettings()).toEqual({
      minClusterSize: DEFAULT_SETTINGS.minClusterSize,
      minSharedItems: 3,
      lookbackDays: 5,
      burstWindowMinutes: DEFAULT_SETTINGS.burstWindowMinutes,
    });
  });

  it('0 や負数・小数は既定値に倒す', async () => {
    await chrome.storage.sync.set({
      settings: { minClusterSize: 0, minSharedItems: -1, lookbackDays: 2.5 },
    });
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('設定そのものが壊れていても例外を投げない', async () => {
    await chrome.storage.sync.set({ settings: 'broken' });
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('旧い 3 項目だけの保存値でも、新項目は既定値で埋まる', async () => {
    // Arrange — Phase 8 以前に保存された設定。マイグレーションは書かない
    await chrome.storage.sync.set({
      settings: { minClusterSize: 8, minSharedItems: 3, lookbackDays: 5 },
    });
    // Act & Assert — 既存 3 項目は活き、新項目だけが既定になる
    expect(await getSettings()).toEqual({
      minClusterSize: 8,
      minSharedItems: 3,
      lookbackDays: 5,
      burstWindowMinutes: DEFAULT_SETTINGS.burstWindowMinutes,
    });
  });
});

/**
 * 投稿直後の幅（Phase 9）。**下限（絞り込み）は作らなかった。**
 *
 * いつ押すかを握っているのは攻撃側なので、下限を設ければ時刻をずらすだけで
 * 候補から消え、しかも消えたことはユーザーに見えない。
 */
describe('getSettings の burstWindowMinutes', () => {
  it('保存されていればその値を返す', async () => {
    await chrome.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, burstWindowMinutes: 180 } });
    expect((await getSettings()).burstWindowMinutes).toBe(180);
  });

  it('0 や負数・小数・文字列は既定値に倒す（幅 0 分は意味を成さない）', async () => {
    for (const broken of [0, -30, 1.5, '60', null]) {
      await chrome.storage.sync.set({
        settings: { ...DEFAULT_SETTINGS, burstWindowMinutes: broken },
      });
      expect((await getSettings()).burstWindowMinutes).toBe(DEFAULT_SETTINGS.burstWindowMinutes);
    }
  });

  it('下限（minBurstScore）は Settings に存在しない', () => {
    // **撤回した設定が復活していないことの番人。**
    // 保存済みの古い値が残っていても読まない
    expect(DEFAULT_SETTINGS).not.toHaveProperty('minBurstScore');
  });
});

/** 表示の設定。判定に関係しないので local に置く（muteOnValid と同じ） */
describe('getFoldTarget / saveFoldTarget', () => {
  it('未設定なら none', async () => {
    await expect(storage.getFoldTarget()).resolves.toBe('none');
  });

  it('保存した値を読み戻せる', async () => {
    await storage.saveFoldTarget('judged');
    await expect(storage.getFoldTarget()).resolves.toBe('judged');
  });

  it('知らない値は none に倒す', async () => {
    // 通すと UI の switch が文言を返せずに落ちる
    await chrome.storage.local.set({ foldTarget: 'everything' });
    await expect(storage.getFoldTarget()).resolves.toBe('none');
  });

  it('数値でも例外を投げず none に倒す', async () => {
    await chrome.storage.local.set({ foldTarget: 3 });
    await expect(storage.getFoldTarget()).resolves.toBe('none');
  });

  it('local に置く（sync には書かない）', async () => {
    await storage.saveFoldTarget('muted');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });
});

/**
 * 評価はユーザーが積み上げた資産で、候補と違って再計算では復元できない。
 * 1 件壊れていても全体を捨てない。
 */
describe('getFeedback / saveVerdict', () => {
  it('未保存なら空オブジェクト', async () => {
    expect(await getFeedback()).toEqual({});
  });

  it('判定を保存して読み戻せる', async () => {
    await saveVerdict('example-author-a', 'valid');
    expect(await getFeedback()).toEqual({ 'example-author-a': 'valid' });
  });

  it('既存の判定を消さずに足す', async () => {
    // Arrange
    await saveVerdict('example-author-a', 'valid');
    // Act — ポップアップを 2 枚開いても消し合わないこと
    await saveVerdict('example-author-b', 'false_positive');
    // Assert
    expect(await getFeedback()).toEqual({
      'example-author-a': 'valid',
      'example-author-b': 'false_positive',
    });
  });

  it('同じ著者は上書きする（二重計上しない）', async () => {
    await saveVerdict('example-author-a', 'valid');
    await saveVerdict('example-author-a', 'false_positive');
    expect(await getFeedback()).toEqual({ 'example-author-a': 'false_positive' });
  });

  it('知らない値が混ざっていても他の判定は残す', async () => {
    // Arrange
    await chrome.storage.local.set({
      feedback: { 'example-author-a': 'valid', 'example-author-b': 'maybe' },
    });
    // Act & Assert
    expect(await getFeedback()).toEqual({ 'example-author-a': 'valid' });
  });

  it('配列が入っていても例外を投げず空を返す', async () => {
    await chrome.storage.local.set({ feedback: ['broken'] });
    await expect(getFeedback()).resolves.toEqual({});
  });
});

describe('saveVerdict の戻り値', () => {
  it('書いた後の全体を返す（呼び出し側が読み直さずに済む）', async () => {
    // Arrange
    await saveVerdict('example-author-a', 'valid');
    // Act
    const merged = await saveVerdict('example-author-b', 'false_positive');
    // Assert — 捨てると 1 クリックあたり storage の往復が 3 回になる
    expect(merged).toEqual({
      'example-author-a': 'valid',
      'example-author-b': 'false_positive',
    });
    expect(merged).toEqual(await getFeedback());
  });
});

/**
 * 著者の巡回記録。**1 件壊れていても全体を捨てない。**
 * 捨てると全著者が「未訪問」になり、次のスキャンで一斉に叩きに行く。
 */
describe('getAuthorVisits', () => {
  it('保存した記録をそのまま返す', async () => {
    // Arrange
    const visits = { 'example-author-1': '2026-08-19T12:00:00.000Z' };
    await saveAuthorVisits(visits);
    // Act & Assert
    expect(await getAuthorVisits()).toEqual(visits);
  });

  it('未保存なら空を返す', async () => {
    expect(await getAuthorVisits()).toEqual({});
  });

  it('オブジェクトでない値は空に倒す', async () => {
    // Arrange
    await chrome.storage.local.set({ authorVisits: 'broken' });
    // Act & Assert
    expect(await getAuthorVisits()).toEqual({});
  });

  it('配列は空に倒す（キーが数字の記録になってしまう）', async () => {
    await chrome.storage.local.set({ authorVisits: ['2026-08-19T12:00:00.000Z'] });
    expect(await getAuthorVisits()).toEqual({});
  });

  it('壊れた 1 件だけを落として残りは返す', async () => {
    // Arrange — 文字列でない値が混ざった
    await chrome.storage.local.set({
      authorVisits: { 'example-author-1': '2026-08-19T12:00:00.000Z', 'example-author-2': 42 },
    });
    // Act & Assert
    expect(await getAuthorVisits()).toEqual({ 'example-author-1': '2026-08-19T12:00:00.000Z' });
  });

  it('空文字は落とす（時刻として使えない）', async () => {
    await chrome.storage.local.set({ authorVisits: { 'example-author-1': '' } });
    expect(await getAuthorVisits()).toEqual({});
  });
});

/**
 * 「妥当」と同時のミュート。**既定は false。**
 * Settings（sync）に入れないのは、あれが detectCandidates の入力だから。
 */
describe('getMuteOnValid / saveMuteOnValid', () => {
  it('未設定なら false', async () => {
    await expect(storage.getMuteOnValid()).resolves.toBe(false);
  });

  it('保存した値を返す', async () => {
    await storage.saveMuteOnValid(true);
    await expect(storage.getMuteOnValid()).resolves.toBe(true);
  });

  it('文字列の "false" を true と読まない', async () => {
    // Boolean() で判定すると通ってしまう。=== true で見ること
    await chrome.storage.local.set({ muteOnValid: 'false' });
    await expect(storage.getMuteOnValid()).resolves.toBe(false);
  });

  it('local に置く（sync には書かない）', async () => {
    // 動作の切り替えであって判定の閾値ではない
    await storage.saveMuteOnValid(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });
});

describe('getMuteLog / recordMuteOutcome', () => {
  const NOW = new Date('2026-08-24T12:00:00.000Z');

  it('未設定なら空', async () => {
    await expect(storage.getMuteLog()).resolves.toEqual({});
  });

  it('記録して、書いた後の全体を返す', async () => {
    // Arrange & Act
    const log = await storage.recordMuteOutcome('example-author-a', 'muted', NOW);
    // Assert — 呼び出し側が読み直さずに済む（saveVerdict と同じ形）。
    // 成功したときは mutedAt も立つ（そのあと not-on-page になっても消えない）
    expect(log).toEqual({
      'example-author-a': {
        outcome: 'muted',
        at: '2026-08-24T12:00:00.000Z',
        mutedAt: '2026-08-24T12:00:00.000Z',
      },
    });
    await expect(storage.getMuteLog()).resolves.toEqual(log);
  });

  it('読んで足して書く（既存の記録を消さない）', async () => {
    // Arrange — ポップアップを 2 枚開いても互いの記録を消し合わない
    await storage.recordMuteOutcome('example-author-a', 'muted', NOW);
    // Act
    const log = await storage.recordMuteOutcome('example-author-b', 'timeout', NOW);
    // Assert
    expect(Object.keys(log).sort()).toEqual(['example-author-a', 'example-author-b']);
  });

  it('同じ著者は上書きする（最後に試した結果だけを持つ）', async () => {
    await storage.recordMuteOutcome('example-author-a', 'timeout', NOW);
    const log = await storage.recordMuteOutcome('example-author-a', 'muted', NOW);
    expect(log['example-author-a']?.outcome).toBe('muted');
  });

  it('知らない outcome の 1 件だけを落とし、他は残す', async () => {
    // Arrange — 壊れていても全体を捨てない（getFeedback と同じ扱い）
    await chrome.storage.local.set({
      muteLog: {
        'example-author-a': { outcome: 'muted', at: '2026-08-24T12:00:00.000Z' },
        'example-author-b': { outcome: 'something-else', at: '2026-08-24T12:00:00.000Z' },
        'example-author-c': { outcome: 'muted' },
        'example-author-d': 'muted',
      },
    });
    // Act & Assert
    await expect(storage.getMuteLog()).resolves.toEqual({
      'example-author-a': { outcome: 'muted', at: '2026-08-24T12:00:00.000Z' },
    });
  });

  it('配列が入っていても例外を投げない', async () => {
    await chrome.storage.local.set({ muteLog: [] });
    await expect(storage.getMuteLog()).resolves.toEqual({});
  });
});

/**
 * ミュートに成功した事実を、試行の結果だけで取り消さない。
 *
 * 押し直したときに返るのは、ページを読み込み直す前なら `already-muted`
 * （カードが DOM に残っている）、読み込み直したあとなら `not-on-page`
 * （記事ごとトレンドから消える）。**どちらも「解除されたか」を区別できない**ので、
 * ここで消すと UI が「まだミュートできていない」と誤って案内する。
 *
 * **消すのは forgetMuteConfirmation だけ**（下の describe）。解除の証拠は
 * 試行の結果ではなく、トレンドに著者が戻ってきたという事実の側から来る。
 */
describe('recordMuteOutcome の mutedAt', () => {
  const FIRST = new Date('2026-08-24T12:00:00.000Z');
  const SECOND = new Date('2026-08-24T13:00:00.000Z');

  it('成功したときに立つ', async () => {
    const log = await storage.recordMuteOutcome('example-author-a', 'muted', FIRST);
    expect(log['example-author-a']?.mutedAt).toBe('2026-08-24T12:00:00.000Z');
  });

  it('そのあと not-on-page になっても消えない', async () => {
    // Arrange
    await storage.recordMuteOutcome('example-author-a', 'muted', FIRST);
    // Act — ミュート済みなのでカードがトレンドから消えている
    const log = await storage.recordMuteOutcome('example-author-a', 'not-on-page', SECOND);
    // Assert
    expect(log['example-author-a']).toEqual({
      outcome: 'not-on-page',
      at: '2026-08-24T13:00:00.000Z',
      mutedAt: '2026-08-24T12:00:00.000Z',
    });
  });

  it('一度も成功していなければ立たない', async () => {
    const log = await storage.recordMuteOutcome('example-author-a', 'no-trend-tab', FIRST);
    expect(log['example-author-a']?.mutedAt).toBeUndefined();
  });

  it('already-muted でも立つ（押していないが、ミュート中だと確認できている）', async () => {
    // Arrange — 拡張は押していない。メニューの項目が解除側だっただけ。
    // **mutedAt は「いつ押したか」ではなく「いつミュート中だと確認できたか」**
    // Act
    const log = await storage.recordMuteOutcome('example-author-a', 'already-muted', FIRST);
    // Assert
    expect(log['example-author-a']?.mutedAt).toBe('2026-08-24T12:00:00.000Z');
  });

  it('already-muted は確認のたびに更新する', async () => {
    // Arrange — 1 時間後にもう一度「妥当」を押して、まだミュート中だと分かった
    await storage.recordMuteOutcome('example-author-a', 'muted', FIRST);
    // Act
    const log = await storage.recordMuteOutcome('example-author-a', 'already-muted', SECOND);
    // Assert — 確認できた最新の時刻に進む
    expect(log['example-author-a']?.mutedAt).toBe('2026-08-24T13:00:00.000Z');
  });

  it('menu-unavailable では立たない（画面構造の変化は確認ではない）', async () => {
    // Arrange — already-muted と混ぜると、壊れているのに「ミュート中」と記録する
    // Act
    const log = await storage.recordMuteOutcome('example-author-a', 'menu-unavailable', FIRST);
    // Assert
    expect(log['example-author-a']?.mutedAt).toBeUndefined();
  });

  it('成功し直したら更新する', async () => {
    await storage.recordMuteOutcome('example-author-a', 'muted', FIRST);
    const log = await storage.recordMuteOutcome('example-author-a', 'muted', SECOND);
    expect(log['example-author-a']?.mutedAt).toBe('2026-08-24T13:00:00.000Z');
  });

  it('storage から読み直しても残る', async () => {
    await storage.recordMuteOutcome('example-author-a', 'muted', FIRST);
    await storage.recordMuteOutcome('example-author-a', 'not-on-page', SECOND);
    const log = await storage.getMuteLog();
    expect(log['example-author-a']?.mutedAt).toBe('2026-08-24T12:00:00.000Z');
  });
});

/**
 * ★ 解除の検知。**ミュート済みの著者は新規ロードのトレンドに載らない**
 * （2026-09-16 ユーザー実測: 3 記事のうち 1 件をミュートしても DOM は 3 件のまま。
 * ページを更新すると 0 件）。だから戻ってきた著者は解除されたと確定できる。
 */
describe('forgetMuteConfirmation', () => {
  const MUTED_AT = new Date('2026-09-16T10:00:00.000Z');
  const BEFORE = '2026-09-16T09:00:00.000Z';
  const AFTER = '2026-09-16T11:00:00.000Z';

  it('戻ってきた著者の記録を捨てる', async () => {
    // Arrange
    await storage.recordMuteOutcome('example-author-a', 'muted', MUTED_AT);
    // Act — 確認より後に撮ったトレンドに、その著者が居た
    const log = await storage.forgetMuteConfirmation(['example-author-a'], AFTER);
    // Assert — **記録ごと捨てる。**mutedAt だけ消すと outcome が残り、
    // UI が「Qiita 側でミュートしました。」と言い続ける
    expect(log).toEqual({});
  });

  it('★ 確認より前に撮ったスナップショットでは捨てない', async () => {
    // Arrange — TREND_ITEMS はページ読み込み時のスナップショット。service worker が
    // 処理する頃にはユーザーが既にミュートを押しているかもしれない。
    // **押す前の画面を根拠に、押した記録を消してはいけない**
    await storage.recordMuteOutcome('example-author-a', 'muted', MUTED_AT);
    // Act
    const log = await storage.forgetMuteConfirmation(['example-author-a'], BEFORE);
    // Assert
    expect(log['example-author-a']?.mutedAt).toBe('2026-09-16T10:00:00.000Z');
  });

  it('スナップショットに居ない著者は触らない', async () => {
    await storage.recordMuteOutcome('example-author-a', 'muted', MUTED_AT);
    const log = await storage.forgetMuteConfirmation(['example-author-b'], AFTER);
    expect(log['example-author-a']?.mutedAt).toBe('2026-09-16T10:00:00.000Z');
  });

  it('ミュートできていない記録は捨てない（失敗の履歴は残す）', async () => {
    // Arrange — 一度も成功していないので mutedAt が無い
    await storage.recordMuteOutcome('example-author-a', 'menu-unavailable', MUTED_AT);
    // Act
    const log = await storage.forgetMuteConfirmation(['example-author-a'], AFTER);
    // Assert
    expect(log['example-author-a']?.outcome).toBe('menu-unavailable');
  });

  it('スナップショット側の時刻が読めなければ捨てない', async () => {
    // 証拠が読めないなら残す側に倒す。消しすぎると、ミュート済みの著者に
    // 「ミュートする」を出すことになる
    await storage.recordMuteOutcome('example-author-a', 'muted', MUTED_AT);
    const log = await storage.forgetMuteConfirmation(['example-author-a'], 'not-a-date');
    expect(log['example-author-a']?.mutedAt).toBe('2026-09-16T10:00:00.000Z');
  });

  it('★ 記録側の時刻が読めなければ捨てない', async () => {
    // Arrange — **上のテストとは別の分岐。**getMuteLog は mutedAt を
    // 「空でない文字列」としか検査しないので、壊れた値はここまで届く。
    // 2 つの NaN のうち片方しか通していなかったことは変異テストで露見した
    await chrome.storage.local.set({
      muteLog: {
        'example-author-a': { outcome: 'muted', at: '2026-09-16T10:00:00.000Z', mutedAt: 'x' },
      },
    });
    // Act
    const log = await storage.forgetMuteConfirmation(['example-author-a'], AFTER);
    // Assert
    expect(log['example-author-a']?.mutedAt).toBe('x');
  });

  it('storage に書き戻る（開き直しても消えたまま）', async () => {
    await storage.recordMuteOutcome('example-author-a', 'muted', MUTED_AT);
    await storage.forgetMuteConfirmation(['example-author-a'], AFTER);
    await expect(storage.getMuteLog()).resolves.toEqual({});
  });

  it('捨てるものが無ければ書き込まない', async () => {
    // Arrange — 無駄な set は storage.onChanged を発火させ、content script の
    // applyHiding を毎回走らせる。トレンドページを開くたびに起きるので効く。
    // **setup.ts の set は既に vi.fn なので、spyOn では過去の履歴ごと拾う。**
    // 前後の差で見る
    await storage.recordMuteOutcome('example-author-a', 'muted', MUTED_AT);
    const setMock = mockOf(chrome.storage.local, 'set');
    const before = setMock.mock.calls.length;
    // Act
    await storage.forgetMuteConfirmation(['example-author-b'], AFTER);
    // Assert
    expect(setMock.mock.calls.length).toBe(before);
  });
});

describe('トレンドのスナップショット', () => {
  const NOW = new Date('2026-09-16T10:00:00.000Z');

  it('撮っていなければ null（「1 件も読めなかった」と区別する）', async () => {
    // **空配列と取り違えない。**null を空配列にすると、更新直後のユーザーの
    // 候補が全員「トレンドに出ていません」になる
    await expect(storage.getTrendSnapshot()).resolves.toBeNull();
  });

  it('著者の重複を落として保存する', async () => {
    // Arrange — 同じ著者がトレンドに 3 本出しているのは常態
    const handles = ['example-author-b', 'example-author-a', 'example-author-b'];
    // Act
    const saved = await storage.saveTrendSnapshot(handles, NOW);
    // Assert
    expect(saved).toEqual({
      authors: ['example-author-a', 'example-author-b'],
      at: '2026-09-16T10:00:00.000Z',
    });
  });

  it('書いたものが読み戻る', async () => {
    await storage.saveTrendSnapshot(['example-author-a'], NOW);
    await expect(storage.getTrendSnapshot()).resolves.toEqual({
      authors: ['example-author-a'],
      at: '2026-09-16T10:00:00.000Z',
    });
  });

  it('1 件も読めなかったことは記録できる（null とは別物）', async () => {
    await storage.saveTrendSnapshot([], NOW);
    await expect(storage.getTrendSnapshot()).resolves.toEqual({
      authors: [],
      at: '2026-09-16T10:00:00.000Z',
    });
  });

  it('壊れた値は null に倒す', async () => {
    await chrome.storage.local.set({ trendSnapshot: { authors: 'example-author-a' } });
    await expect(storage.getTrendSnapshot()).resolves.toBeNull();
  });

  it('時刻が無ければ null に倒す（いつ撮ったか言えないと使えない）', async () => {
    await chrome.storage.local.set({ trendSnapshot: { authors: ['example-author-a'] } });
    await expect(storage.getTrendSnapshot()).resolves.toBeNull();
  });

  it('著者の中に壊れた要素があっても、その要素だけ落とす', async () => {
    await chrome.storage.local.set({
      trendSnapshot: { authors: ['example-author-a', 42, ''], at: '2026-09-16T10:00:00.000Z' },
    });
    await expect(storage.getTrendSnapshot()).resolves.toEqual({
      authors: ['example-author-a'],
      at: '2026-09-16T10:00:00.000Z',
    });
  });
});
