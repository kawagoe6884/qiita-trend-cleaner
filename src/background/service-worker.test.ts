import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QtgRequest, QtgResponse } from '../types/messages';

vi.mock('./scanner', () => ({ runScan: vi.fn() }));

type InstalledListener = (details: { reason: string }) => void;
type StartupListener = () => void;
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('service worker の配線', () => {
  it('定期実行（alarms）を一切登録しない', async () => {
    // Arrange — 起動しただけでは足りない。alarms.create は onInstalled の中に
    // 書かれるのが自然なので、ライフサイクルを一巡させてから検査する
    await bootServiceWorker();
    firstListener<InstalledListener>(chrome.runtime.onInstalled)({ reason: 'install' });
    firstListener<StartupListener>(chrome.runtime.onStartup)();

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

  it('インストール時に 1 回だけスキャンする', async () => {
    // Arrange
    const { runScan } = await bootServiceWorker();
    const onInstalled = firstListener<InstalledListener>(chrome.runtime.onInstalled);
    // Act
    onInstalled({ reason: 'install' });
    // Assert — 初回はキャッシュが空なので必ず取得が走る唯一の自動実行
    expect(runScan).toHaveBeenCalledTimes(1);
  });

  it('ブラウザ起動時にスキャンする', async () => {
    // Arrange
    const { runScan } = await bootServiceWorker();
    const onStartup = firstListener<StartupListener>(chrome.runtime.onStartup);
    // Act
    onStartup();
    // Assert — フィード不変なら API を叩かずに終わるので枠を消費しない
    expect(runScan).toHaveBeenCalledTimes(1);
  });

  it('SCAN_NOW を受けたらスキャンし SCAN_ACCEPTED を返す', async () => {
    // Arrange
    const { runScan } = await bootServiceWorker();
    const onMessage = firstListener<MessageListener>(chrome.runtime.onMessage);
    const sendResponse = vi.fn();
    // Act
    const keepChannelOpen = onMessage({ type: 'SCAN_NOW' }, null, sendResponse);
    // Assert
    expect(runScan).toHaveBeenCalledTimes(1);
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
    const onStartup = firstListener<StartupListener>(chrome.runtime.onStartup);
    // Act & Assert — catch し損ねると unhandled rejection になり原因が追えない
    expect(() => {
      onStartup();
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });
    errorSpy.mockRestore();
  });
});
