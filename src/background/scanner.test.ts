import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runScan } from './scanner';
import { fetchLikes, fetchUserItems } from '../api/qiita-client';
import {
  saveToken,
  getLikeIndex,
  saveLikeIndex,
  getCandidates,
  getRateLimitedUntil,
  saveSettings,
} from '../lib/storage';
import { RateLimitError } from '../lib/errors';
import { logger } from '../lib/logger';
import { countRecords } from '../detect/like-index';
import type { TrendItem } from '../types/domain';

vi.mock('../api/qiita-client', () => ({ fetchLikes: vi.fn(), fetchUserItems: vi.fn() }));

const likesMock = vi.mocked(fetchLikes);
const itemsMock = vi.mocked(fetchUserItems);

/** 合成のトレンド記事。実アカウント名・実 item_id は使わない */
function trendItem(index: number): TrendItem {
  const handle = `example-author-${String(index)}`;
  const itemId = `0123456789abcdef${String(index).padStart(4, '0')}`;
  return {
    itemId,
    url: `https://qiita.com/${handle}/items/${itemId}`,
    authorHandle: handle,
    publishedAt: '2026-08-18T10:00:00+09:00',
  };
}

/** 既定の入力。content script が読んだ 2 件のつもり */
const TWO_ITEMS: TrendItem[] = [trendItem(1), trendItem(2)];

function likeOf(handle: string) {
  return {
    created_at: '2026-08-19T06:00:00+09:00',
    user: { id: handle, items_count: 0, followers_count: 1, description: null },
  };
}

function likesResponse(handles: string[], remaining = 55) {
  return {
    data: handles.map(likeOf),
    totalCount: handles.length,
    rate: { limit: 60, remaining, resetAt: null },
  };
}

/**
 * 判定の窓は **記事の投稿時刻**（`itemPostedAt`）から `lookbackDays` 日で切る。
 * フィクスチャの日付が固定なのに now が実時刻だと、**日が経つだけでテストが落ちる**。
 * 実際 2026-08-20 に緑だったものが 8/23 に 3 件落ちた（コードは 1 行も変えていない）。
 *
 * Date だけ偽装する。setTimeout まで止めると runScan の非同期が進まなくなる。
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-19T12:00:00+09:00'));
  vi.clearAllMocks();
  likesMock.mockResolvedValue(likesResponse(['example-liker-a', 'example-liker-b']));
  // 過去記事は now から 9 日前。RETENTION_DAYS(7) より古いので **取得はされるが
  // 保存されない**。これは Phase 5b（OQ-17）で扱う挙動そのものなので、
  // ここで日付を新しくして隠さない。設計を直すときに一緒に決める
  itemsMock.mockResolvedValue({
    data: [{ id: 'fedcba9876543210fedc', created_at: '2026-08-10T09:00:00+09:00' }],
    totalCount: 1,
    rate: { limit: 1000, remaining: 990, resetAt: null },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runScan', () => {
  it('渡されたトレンド記事をスキャンする', async () => {
    // Act
    const result = await runScan(TWO_ITEMS);
    // Assert
    expect(likesMock).toHaveBeenCalledTimes(2);
    expect(result?.newItemCount).toBe(2);
    expect(result?.scannedItemCount).toBe(2);
  });

  it('空配列なら null を返し、例外も API 呼び出しも無い', async () => {
    // Arrange — トレンド以外のページでは 0 件が正常
    // Act
    const result = await runScan([]);
    // Assert
    expect(result).toBeNull();
    expect(likesMock).not.toHaveBeenCalled();
  });

  it('ライトモードでは著者の過去記事を辿らない', async () => {
    // Arrange — トークン未設定
    // Act
    const result = await runScan(TWO_ITEMS);
    // Assert
    expect(result?.mode).toBe('light');
    expect(itemsMock).not.toHaveBeenCalled();
    expect(likesMock).toHaveBeenCalledTimes(2);
  });

  it('フルモードでは著者の過去記事も辿る', async () => {
    // Arrange
    await saveToken('dummy-token-value');
    // Act
    const result = await runScan(TWO_ITEMS);
    // Assert
    expect(result?.mode).toBe('full');
    expect(itemsMock).toHaveBeenCalledTimes(2);
  });

  it('likers をアカウント単位に畳んで保存する', async () => {
    // Act
    await runScan(TWO_ITEMS);
    // Assert
    const index = await getLikeIndex();
    expect(Object.keys(index).sort()).toEqual(['example-liker-a', 'example-liker-b']);
    expect(index['example-liker-a']?.likes).toHaveLength(2);
    expect(index['example-liker-a']?.likes[0]?.itemPostedAt).toBe('2026-08-18T10:00:00+09:00');
  });

  it('1 記事が失敗しても残りを処理する', async () => {
    // Arrange
    likesMock.mockRejectedValueOnce(new Error('boom'));
    // Act
    const result = await runScan(TWO_ITEMS);
    // Assert
    expect(result?.scannedItemCount).toBe(1);
    expect(likesMock).toHaveBeenCalledTimes(2);
  });

  it('スキャン結果に開始と終了の時刻が入る', async () => {
    const result = await runScan(TWO_ITEMS);
    expect(result?.startedAt).toBeTruthy();
    expect(result?.finishedAt).toBeTruthy();
    expect(result?.likeRecordCount).toBe(4);
  });
});

/**
 * ページをリロードするたびに 30 req 使うと、ライトモードの 60 req/h は
 * 2 回で尽きる。「見ている 30 件を渡す」設計は、既知の除外とセットで成立する。
 */
describe('runScan の既知記事の除外', () => {
  it('既にインデックスにある記事は叩かない', async () => {
    // Arrange — 1 回目で 2 件とも取得済みにする
    await runScan(TWO_ITEMS);
    vi.clearAllMocks();
    likesMock.mockResolvedValue(likesResponse(['example-liker-c']));
    // Act — 3 件目だけが新しい
    const result = await runScan([...TWO_ITEMS, trendItem(3)]);
    // Assert
    expect(likesMock).toHaveBeenCalledTimes(1);
    expect(result?.newItemCount).toBe(1);
  });

  it('全件既知なら API を 1 度も叩かないが、検出は走る', async () => {
    // Arrange
    await runScan(TWO_ITEMS);
    vi.clearAllMocks();
    // Act — 同じページをリロードした状況
    const result = await runScan(TWO_ITEMS);
    // Assert
    expect(likesMock).not.toHaveBeenCalled();
    expect(result?.newItemCount).toBe(0);
    // 蓄積は残り、候補の再計算も行われる
    expect(await getCandidates()).toEqual([]);
    expect(countRecords(await getLikeIndex())).toBe(4);
  });

  it('フルモードでも全件既知なら著者一覧を叩かない', async () => {
    // Arrange — 「リロードでは API を 1 度も叩かない」はライトモードだけの
    // 性質であってはならない。fetchUserItems は seen を見る前に呼ばれるため、
    // 著者を items から取ると既知の記事しか無くても著者数ぶん消費する
    await saveToken('dummy-token-value');
    await runScan(TWO_ITEMS);
    vi.clearAllMocks();
    // Act — 同じページをリロードした状況
    await runScan(TWO_ITEMS);
    // Assert
    expect(likesMock).not.toHaveBeenCalled();
    expect(itemsMock).not.toHaveBeenCalled();
  });
});

/**
 * 429 は「設計どおりの停止信号」であって不具合ではない（改訂 6）。
 * 予測して手前で止めるのをやめた代わりに、止まったことを正しく記録する。
 */
describe('runScan の 429 の扱い', () => {
  it('429 を受けたらそこで止め、取得済みの分は保存する', async () => {
    // Arrange — 1 件目は成功、2 件目で枠切れ
    likesMock.mockResolvedValueOnce(likesResponse(['example-liker-a']));
    likesMock.mockRejectedValueOnce(new RateLimitError(1787104432));
    // Act
    const result = await runScan(TWO_ITEMS);
    // Assert — 途中まででも成果は捨てない
    expect(result?.scannedItemCount).toBe(1);
    expect(Object.keys(await getLikeIndex())).toEqual(['example-liker-a']);
    expect(await getRateLimitedUntil()).toBe(1787104432);
  });

  it('Rate-Reset が読めない 429 では 1 時間後を再開時刻にする', async () => {
    // Arrange
    likesMock.mockRejectedValue(new RateLimitError(null));
    const before = Math.floor(Date.now() / 1000);
    // Act
    await runScan(TWO_ITEMS);
    // Assert — 枠は 1 時間単位で回復する。早すぎる案内より遅い案内を選ぶ
    const until = await getRateLimitedUntil();
    expect(until).toBeGreaterThanOrEqual(before + 3600);
    expect(until).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3600);
  });

  it('429 で止まった残りは次のスキャンで拾える', async () => {
    // Arrange — 1 回目は 1 件目だけ成功
    likesMock.mockResolvedValueOnce(likesResponse(['example-liker-a']));
    likesMock.mockRejectedValueOnce(new RateLimitError(1787104432));
    await runScan(TWO_ITEMS);
    vi.clearAllMocks();
    likesMock.mockResolvedValue(likesResponse(['example-liker-b']));
    // Act — 同じ 2 件を渡す
    const result = await runScan(TWO_ITEMS);
    // Assert — 取り逃した 2 件目だけを叩く
    expect(likesMock).toHaveBeenCalledTimes(1);
    expect(likesMock).toHaveBeenCalledWith(TWO_ITEMS[1]?.itemId, null);
    expect(result?.newItemCount).toBe(1);
  });

  it('429 なしで終わったら再開時刻の記録を消す', async () => {
    // Arrange — 前回 429 で止まっている
    likesMock.mockRejectedValueOnce(new RateLimitError(1787104432));
    await runScan([trendItem(9)]);
    expect(await getRateLimitedUntil()).toBe(1787104432);
    likesMock.mockResolvedValue(likesResponse(['example-liker-a']));
    // Act
    await runScan(TWO_ITEMS);
    // Assert — 「いま止まっているか」だけを表す
    expect(await getRateLimitedUntil()).toBeNull();
  });

  it('フルモードでも 429 のあとは著者の巡回に入らない', async () => {
    // Arrange
    await saveToken('dummy-token-value');
    likesMock.mockRejectedValue(new RateLimitError(1787104432));
    // Act
    await runScan(TWO_ITEMS);
    // Assert — 枠が無いのに追加取得を始めない
    expect(itemsMock).not.toHaveBeenCalled();
  });
});

/**
 * Chrome は console.warn も chrome://extensions のエラー欄に集める（2026-08-19 実測）。
 * qiita-client 側で 401 や 429 を debug へ下げても、scanner の catch が warn のままだと
 * 同じログが経路を変えてエラー欄に戻ってくる。ここはその再発を止める番人。
 */
describe('runScan のログ水準', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
  });

  it('一部の記事が失敗しても warn を出さない', async () => {
    // Arrange — 2 件中 1 件だけ失敗（記事の削除・限定公開・一時的な 5xx 相当）
    likesMock.mockRejectedValueOnce(new Error('boom'));
    // Act
    await runScan(TWO_ITEMS);
    // Assert — 想定内の欠損を「拡張の不具合」として記録しない
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith('skip item:', expect.any(String), expect.any(Error));
  });

  it('失効トークンで全記事が 401 になっても warn の連発にはしない', async () => {
    // Arrange — スキャン中の 401 は全件同じ理由で落ちる
    await saveToken('dummy-token-value');
    likesMock.mockRejectedValue(new Error('api auth rejected (401)'));
    itemsMock.mockRejectedValue(new Error('api auth rejected (401)'));
    // Act
    await runScan(TWO_ITEMS);
    // Assert — 件数ぶん積み上がらず、集計の 1 行だけに畳まれる
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('scan produced no data: all', 2, 'items failed');
  });

  it('全記事が失敗したときだけ warn で知らせる', async () => {
    // Arrange — API 仕様変更なら全滅する。これは本当に壊れている
    likesMock.mockRejectedValue(new Error('boom'));
    // Act
    const result = await runScan(TWO_ITEMS);
    // Assert
    expect(result?.scannedItemCount).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith('scan produced no data: all', 2, 'items failed');
  });

  it('429 は全滅と区別する（warn を出さない）', async () => {
    // Arrange — 1 件目で枠切れ。0 件しか取れていないが「壊れている」わけではない
    likesMock.mockRejectedValue(new RateLimitError(1787104432));
    // Act
    const result = await runScan(TWO_ITEMS);
    // Assert — 正常な無料プランの挙動をエラー欄に載せない
    expect(result?.scannedItemCount).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('著者の過去記事の取得に失敗しても warn を出さない', async () => {
    // Arrange — フルモードで著者一覧だけ落とす（記事本体は成功する）
    await saveToken('dummy-token-value');
    itemsMock.mockRejectedValue(new Error('boom'));
    // Act
    await runScan(TWO_ITEMS);
    // Assert — 記事は取れているので全滅ではない
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith('skip author:', expect.any(String), expect.any(Error));
  });

  it('検出はゼロ件でも warn を出さない', async () => {
    // Arrange — 既定は 2 記事 / 2 アカウントなので閾値（N=5 M=2）に届かない
    // Act
    await runScan(TWO_ITEMS);
    // Assert — 「候補なし」は正常。エラー欄に載せない
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('トレンド以外のページ（0 件）でも warn を出さない', async () => {
    await runScan([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

/**
 * 蓄積と検出の配線。detect/ をモックせず実物を通す。
 * ここをモックすると「配線されているか」が検証できない。
 */
describe('runScan の蓄積と検出', () => {
  /** 著者 A の記事に count 人が揃った likes 応答を作る */
  function clusterLikes(count: number) {
    const handles = Array.from({ length: count }, (_, i) => `example-liker-${String(i + 1)}`);
    return likesResponse(handles);
  }

  it('2 回スキャンするとインデックスが蓄積される', async () => {
    // Arrange — 1 回目は記事 1,2
    await runScan(TWO_ITEMS);
    const afterFirst = countRecords(await getLikeIndex());
    // Act — 2 回目は別のトレンドセット（記事 3,4）
    await runScan([trendItem(3), trendItem(4)]);
    // Assert — 上書きなら afterFirst のままになる
    expect(countRecords(await getLikeIndex())).toBe(afterFirst * 2);
  });

  it('同じトレンドを 2 回処理しても重複しない', async () => {
    // Arrange & Act
    await runScan(TWO_ITEMS);
    const afterFirst = countRecords(await getLikeIndex());
    await runScan(TWO_ITEMS);
    // Assert — アカウントが同じ記事に 2 回いいねすることはない
    expect(countRecords(await getLikeIndex())).toBe(afterFirst);
  });

  it('検出結果が storage に保存される', async () => {
    // Arrange — 5 人が著者 1 の 2 記事に揃う（N=5 M=2 を満たす）
    likesMock.mockResolvedValue(clusterLikes(5));
    // Act
    await runScan([trendItem(1), { ...trendItem(2), authorHandle: 'example-author-1' }]);
    // Assert
    const candidates = await getCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.authorHandle).toBe('example-author-1');
    expect(candidates[0]?.clusterSize).toBe(5);
  });

  it('候補ゼロでも空配列が保存される', async () => {
    // Act — 既定のフィクスチャは 2 アカウントしかいない
    await runScan(TWO_ITEMS);
    // Assert — 未保存（undefined）ではなく空配列
    expect(await getCandidates()).toEqual([]);
  });

  it('429 で止まっても蓄積と検出は行う', async () => {
    // Arrange
    likesMock.mockResolvedValueOnce(likesResponse(['example-liker-a']));
    likesMock.mockRejectedValueOnce(new RateLimitError(1787104432));
    // Act
    await runScan(TWO_ITEMS);
    // Assert — 途中まででも成果は捨てない
    expect(countRecords(await getLikeIndex())).toBe(1);
    expect(await getCandidates()).toEqual([]);
  });
});

/**
 * content script は qiita.com のページを開くたびに TREND_ITEMS を送る。
 * 2 タブ同時、あるいはスキャン中のリロードで runScan が重なりうる。
 * service-worker には待ち行列もロックも無い（fire-and-forget）。
 */
describe('runScan の同時実行', () => {
  /**
   * likes の 1 回目で止め、そこに到達したことを呼び出し側に知らせる。
   *
   * entered を待たずに storage を書くと、モックの set が Map を **同期的に**
   * 書き換えるため、スキャンが getLikeIndex を読む前に着地してしまう。
   * それでは「読んだあとに他者が書いた」状況を再現できず、テストが素通りする。
   */
  function gateFirstFetch(): { entered: Promise<void>; release: () => void } {
    let release = (): void => undefined;
    let markEntered = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    likesMock.mockImplementationOnce(() => {
      markEntered();
      return gate.then(() => likesResponse(['example-liker-a', 'example-liker-b']));
    });
    return {
      entered,
      release: () => {
        release();
      },
    };
  }

  it('スキャン中に来た 2 本目は走らせない（枠の二重消費を防ぐ）', async () => {
    // Arrange — 1 本目を 1 記事目で止める
    const gate = gateFirstFetch();
    const first = runScan(TWO_ITEMS);
    await gate.entered;
    // Act — 別タブが同じトレンドを送ってきた
    const second = await runScan(TWO_ITEMS);
    gate.release();
    await first;
    // Assert — 2 本目が走ると同じ件数をもう一度叩き、60 req/h を一気に使う
    expect(second).toBeNull();
    expect(likesMock).toHaveBeenCalledTimes(2);
  });

  it('スキャン中に保存された蓄積を上書きで消さない', async () => {
    // Arrange — スキャンが storage を読んだ **あと** に別の書き手が保存した状況。
    // 開始時のスナップショットを持ち回ると、この分が保存時に消える
    const gate = gateFirstFetch();
    const first = runScan(TWO_ITEMS);
    await gate.entered;
    await saveLikeIndex({
      'example-outsider': {
        likes: [
          {
            itemId: 'ffffffffffffffffffff',
            authorHandle: 'example-author-9',
            likedAt: '2026-08-19T06:00:00+09:00',
            itemPostedAt: '2026-08-19T05:30:00+09:00',
          },
        ],
        itemsCount: 0,
        followersCount: 1,
        hasDescription: false,
      },
    });
    // Act
    gate.release();
    await first;
    // Assert — 保存の直前に読み直していれば残る
    expect(Object.keys(await getLikeIndex())).toContain('example-outsider');
  });
});

/**
 * 閾値はポップアップのスライダーで動かせる。
 * scanner が DEFAULT_SETTINGS を直接見ていると、スライダーを動かしても
 * 次のスキャンが既定値で candidates を上書きしてしまう。
 */
describe('runScan の設定とバッジ', () => {
  /**
   * chrome API のモックを取り出す。メソッドを直接渡すと unbound-method に
   * 引っかかるため、持ち主とキーで受け取る。
   */
  function mockOf<T extends object, K extends keyof T>(owner: T, key: K) {
    return vi.mocked(owner[key] as (...args: unknown[]) => unknown);
  }

  /** 著者 example-author-1 の 2 記事に 2 人が揃う入力 */
  const SAME_AUTHOR: TrendItem[] = [
    trendItem(1),
    { ...trendItem(2), authorHandle: 'example-author-1' },
  ];

  it('保存された閾値で検出する', async () => {
    // Arrange — 既定（N=5）では出ないが N=2 なら出る
    await saveSettings({ minClusterSize: 2, minSharedItems: 2, lookbackDays: 3 });
    // Act
    await runScan(SAME_AUTHOR);
    // Assert
    const candidates = await getCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.authorHandle).toBe('example-author-1');
  });

  it('設定が無ければ既定値で検出する', async () => {
    // Act — 2 アカウントしかいないので N=5 に届かない
    await runScan(SAME_AUTHOR);
    // Assert
    expect(await getCandidates()).toEqual([]);
  });

  it('候補件数をバッジに出す', async () => {
    // Arrange
    await saveSettings({ minClusterSize: 2, minSharedItems: 2, lookbackDays: 3 });
    // Act
    await runScan(SAME_AUTHOR);
    // Assert
    expect(mockOf(chrome.action, 'setBadgeText')).toHaveBeenCalledWith({ text: '1' });
  });

  it('候補ゼロならバッジを空にする', async () => {
    // Act
    await runScan(TWO_ITEMS);
    // Assert — 前回の件数が残り続けると嘘の表示になる
    expect(mockOf(chrome.action, 'setBadgeText')).toHaveBeenCalledWith({ text: '' });
  });

  it('429 中はバッジを記号にする', async () => {
    // Arrange — バッジは 4 文字程度しか入らない。残り時間はポップアップで伝える
    likesMock.mockRejectedValue(new RateLimitError(1787104432));
    // Act
    await runScan(TWO_ITEMS);
    // Assert
    expect(mockOf(chrome.action, 'setBadgeText')).toHaveBeenCalledWith({ text: '!' });
  });

  it('バッジの更新に失敗してもスキャンは成立する', async () => {
    // Arrange
    mockOf(chrome.action, 'setBadgeText').mockRejectedValue(new Error('boom'));
    // Act & Assert — バッジが出ないだけで蓄積も検出も終わっている
    await expect(runScan(TWO_ITEMS)).resolves.not.toBeNull();
    expect(countRecords(await getLikeIndex())).toBe(4);
  });
});
