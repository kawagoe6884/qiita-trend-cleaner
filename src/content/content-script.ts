import { logger } from '../lib/logger';
import { INJECTION_MARKER } from '../dom/selectors';
import { readTrendItems, isTrendPage } from '../dom/trend-reader';
import type { QtgRequest, QtgResponse } from '../types/messages';

function markInjected(version: string): void {
  document.documentElement.dataset[INJECTION_MARKER] = version;
}

/**
 * service worker からの応答を実行時に検証する。
 * 別コンテキストから来る値なので、型アサーションではなく型ガードで受ける。
 */
/** QtgResponse はユニオンなので、PONG だけに絞った型を用意する */
type PongResponse = Extract<QtgResponse, { type: 'PONG' }>;

function isPongResponse(value: unknown): value is PongResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PongResponse>;
  return candidate.type === 'PONG' && typeof candidate.version === 'string';
}

async function ping(): Promise<void> {
  const request: QtgRequest = { type: 'PING' };
  try {
    const response: unknown = await chrome.runtime.sendMessage(request);
    if (isPongResponse(response)) {
      markInjected(response.version);
      logger.info('service worker pong:', response.version);
    } else {
      logger.warn('unexpected response from service worker:', response);
    }
  } catch (error) {
    // service worker 起動中などで失敗しうる。握りつぶさずログに残す
    logger.error('failed to reach service worker:', error);
  }
}

/**
 * 表示中のページからトレンド記事を読み、service worker に渡す。
 *
 * この content script は https://qiita.com/* 全体に注入されるため、
 * **記事ページやプロフィールページでは 0 件が正常**。warn を出さないこと
 * （Chrome は warn もエラー欄に集める）。
 */
async function sendTrendItems(): Promise<void> {
  // プロフィールページにもその人の記事一覧があり、記事リンクと <time> が揃う。
  // 読む対象をページで絞らないと、トレンドでない記事に枠を使う
  if (!isTrendPage(location.pathname)) {
    logger.debug('not a trend page:', location.pathname);
    return;
  }
  const items = readTrendItems();
  if (items.length === 0) {
    logger.debug('no trend items on this page');
    return;
  }
  logger.info('trend items read:', items.length);
  try {
    const request: QtgRequest = { type: 'TREND_ITEMS', items };
    await chrome.runtime.sendMessage(request);
  } catch (error) {
    // service worker に届かない原因は ping() が既に error で 1 行出している。
    // ここで 2 行目を出すと、**拡張をリロードしたときに開いていた qiita.com の
    // タブ全部で 2 行ずつ**エラー欄に積まれる（古い content script が孤児になり、
    // sendMessage が必ず落ちる）。それはユーザーの操作どおりの結果であって
    // 不具合ではない。届かなかったトレンドは次にページを開けば拾える
    logger.debug('failed to send trend items:', error);
  }
}

logger.info('content script ready');
void ping();
void sendTrendItems();
