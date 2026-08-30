import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QtgRequest, QtgResponse } from '../types/messages';
import type { TrendItem } from '../types/domain';

vi.mock('./scanner', () => ({ runScan: vi.fn() }));

type InstalledListener = (details: { reason: string }) => void;
type MessageListener = (
  message: QtgRequest,
  sender: unknown,
  sendResponse: (response: QtgResponse) => void,
) => boolean;

/**
 * chrome API のモックを取り出す。
 * `chrome.alarms.create` のようにメソッドを直接渡すと unbound-method に
 * 引っかかるため、持ち主とキーで受け取る。
 */
function mockOf<T extends object, K extends keyof T>(owner: T, key: K) {
  return vi.mocked(owner[key] as (...args: unknown[]) => unknown);
}

/** addListener に最初に渡された関数を取り出す */
function firstListener<T>(event: { addListener: unknown }): T {
  const first = mockOf(event, 'addListener').mock.calls[0];
  if (!first) throw new Error('listener not registered');
  return first[0] as T;
}

/**
 * service worker は import しただけで addListener を走らせる。
 * モジュールキャッシュが効くと 2 件目以降のテストで登録を観測できないため、
 * 毎回リセットしてから読み込む。
 */
async function bootServiceWorker() {
  vi.resetModules();
  const scanner = await import('./scanner');
  const runScan = vi.mocked(scanner.runScan);
  runScan.mockResolvedValue(null);
  await import('./service-worker');
  // resetModules 後は logger も別インスタンスになる。
  // ファイル冒頭で import した logger に spy を張っても、service worker が
  // 掴んでいるのは別のオブジェクトなので捕まらない。ここで取り直す
  const { logger } = await import('../lib/logger');
  return { runScan, logger };
}

/** 合成のトレンド記事 */
const ITEM: TrendItem = {
  itemId: '0123456789abcdef0001',
  url: 'https://qiita.com/example-author-1/items/0123456789abcdef0001',
  authorHandle: 'example-author-1',
  publishedAt: '2026-08-18T10:00:00Z',
};

/** 型を外して壊れたメッセージを送る。別コンテキストは何でも送れる */
function malformed(items: unknown): QtgRequest {
  return { type: 'TREND_ITEMS', items } as unknown as QtgRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('service worker の起動契機', () => {
  it('定期実行（alarms）を一切登録しない', async () => {
    // Arrange — 起動しただけでは足りない。alarms.create は onInstalled の中に
    // 書かれるのが自然なので、ライフサイクルを一巡させてから検査する
    await bootServiceWorker();
    firstListener<InstalledListener>(chrome.runtime.onInstalled)({ reason: 'install' });

    // Assert — ライトモードの枠は 60 req/h、1 スキャンは約 30 req。
    // 30 分間隔で回すと枠ちょうどになり、起動時や手動の 1 回で 429 に届く。
    // その 429 は「無料プランの設計どおり」であって不具合ではないのに、
    // Chrome のエラー欄には不具合として記録されてしまう
    expect(mockOf(chrome.alarms, 'create')).not.toHaveBeenCalled();
    expect(mockOf(chrome.alarms.onAlarm, 'addListener')).not.toHaveBeenCalled();
  });

  it('manifest が alarms 権限を要求しない', async () => {
    // Arrange — コードから alarms を消しても権限が残ると、審査で説明のつかない
    // 要求になり、ユーザーにも「常駐して何かする拡張」に見える
    const { default: exported } = await import('../../manifest.config');
    // ManifestV3Export は Promise や関数も許容する型だが、本プロジェクトの定義は
    // プレーンなオブジェクト。必要なキーだけ読む
    const { permissions } = exported as unknown as { permissions: string[] };
    // Act & Assert
    expect(permissions).toEqual(['storage']);
  });

  it('インストール時にスキャンしない', async () => {
    // Arrange
    const { runScan } = await bootServiceWorker();
    const onInstalled = firstListener<InstalledListener>(chrome.runtime.onInstalled);
    // Act
    onInstalled({ reason: 'install' });
    // Assert — トレンドを取りに行かなくなったため、ページを開いていない時点では
    // 見に行く先が無い
    expect(runScan).not.toHaveBeenCalled();
  });

  it('ブラウザ起動のリスナーを登録しない', async () => {
    // Arrange & Act
    await bootServiceWorker();
    // Assert — 起動契機はトレンドページを開いたときだけ
    expect(mockOf(chrome.runtime.onStartup, 'addListener')).not.toHaveBeenCalled();
  });
});

describe('service worker のメッセージ処理', () => {
  it('TREND_ITEMS を受けたらスキャンし SCAN_ACCEPTED を返す', async () => {
    // Arrange
    const { runScan } = await bootServiceWorker();
    const onMessage = firstListener<MessageListener>(chrome.runtime.onMessage);
    const sendResponse = vi.fn();
    // Act
    const keepChannelOpen = onMessage({ type: 'TREND_ITEMS', items: [ITEM] }, null, sendResponse);
    // Assert
    expect(runScan).toHaveBeenCalledWith([ITEM]);
    expect(sendResponse).toHaveBeenCalledWith({ type: 'SCAN_ACCEPTED' });
    // true を返すとチャネルが開きっぱなしになる
    expect(keepChannelOpen).toBe(false);
  });

  it('PING には PONG を返すだけでスキャンしない', async () => {
    // Arrange
    const { runScan } = await bootServiceWorker();
    const onMessage = firstListener<MessageListener>(chrome.runtime.onMessage);
    const sendResponse = vi.fn();
    // Act
    onMessage({ type: 'PING' }, null, sendResponse);
    // Assert
    expect(runScan).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ type: 'PONG', version: '0.0.0-test' });
  });

  it('スキャンが失敗しても例外を投げず error に落とす', async () => {
    // Arrange — spy は boot 後に張る。boot 前だと別インスタンスに当たって空振りする
    const { runScan, logger } = await bootServiceWorker();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    runScan.mockRejectedValueOnce(new Error('boom'));
    const onMessage = firstListener<MessageListener>(chrome.runtime.onMessage);
    // Act & Assert — catch し損ねると unhandled rejection になり原因が追えない
    expect(() => {
      onMessage({ type: 'TREND_ITEMS', items: [ITEM] }, null, vi.fn());
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });
    errorSpy.mockRestore();
  });
});

/**
 * trend-reader が検証済みでも、**メッセージ境界を越えたら再検証する**。
 * ここを通った itemId はそのまま API のパスに入るため、送り手が本当に
 * 自分の content script だったかを型で保証できない以上、受け側で確かめる。
 */
describe('service worker の TREND_ITEMS 検証', () => {
  async function sendItems(items: unknown) {
    const { runScan } = await bootServiceWorker();
    const onMessage = firstListener<MessageListener>(chrome.runtime.onMessage);
    const sendResponse = vi.fn();
    onMessage(malformed(items), null, sendResponse);
    return { runScan, sendResponse };
  }

  it('配列でない items は拒否する', async () => {
    const { runScan, sendResponse } = await sendItems('not-an-array');
    expect(runScan).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('形の違う要素を含む items は拒否する', async () => {
    const { runScan } = await sendItems([{ foo: 1 }]);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('itemId に危険な文字を含む items は拒否する', async () => {
    // Arrange — ".." が通ると /users/../items が /api/items に潰れる
    const { runScan } = await sendItems([{ ...ITEM, itemId: '../admin' }]);
    // Assert
    expect(runScan).not.toHaveBeenCalled();
  });

  it('authorHandle に危険な文字を含む items は拒否する', async () => {
    const { runScan } = await sendItems([{ ...ITEM, authorHandle: 'ex/ample' }]);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('publishedAt が空の items は拒否する', async () => {
    const { runScan } = await sendItems([{ ...ITEM, publishedAt: '' }]);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('1 件でも壊れていれば配列ごと拒否する', async () => {
    // Arrange — 混ざっているときに「良い方だけ通す」と、境界の検証が
    // 部分的にしか効かなくなる
    const { runScan } = await sendItems([ITEM, { foo: 1 }]);
    // Assert
    expect(runScan).not.toHaveBeenCalled();
  });

  it('空配列は受理する（scanner 側で 0 件を正常として扱う）', async () => {
    const { runScan, sendResponse } = await sendItems([]);
    expect(runScan).toHaveBeenCalledWith([]);
    expect(sendResponse).toHaveBeenCalledWith({ type: 'SCAN_ACCEPTED' });
  });
});

/**
 * url は API のパスには入らないが、Phase 6 が候補一覧でリンクとして描画する。
 * typeof チェックだけだと javascript: スキームを持ち込める。
 */
describe('service worker の url 検証', () => {
  async function sendItems(items: unknown) {
    const { runScan } = await bootServiceWorker();
    const onMessage = firstListener<MessageListener>(chrome.runtime.onMessage);
    onMessage(malformed(items), null, vi.fn());
    return runScan;
  }

  it('handle と itemId から組み立てた形と違う url は拒否する', async () => {
    const runScan = await sendItems([{ ...ITEM, url: 'https://evil.example.com/x' }]);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('javascript: スキームの url は拒否する', async () => {
    const runScan = await sendItems([{ ...ITEM, url: 'javascript:alert(1)' }]);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('別の記事を指す url は拒否する', async () => {
    // Arrange — itemId は正しいが url が他人の記事を指している
    const runScan = await sendItems([
      { ...ITEM, url: 'https://qiita.com/example-author-2/items/0123456789abcdef0001' },
    ]);
    expect(runScan).not.toHaveBeenCalled();
  });
});
