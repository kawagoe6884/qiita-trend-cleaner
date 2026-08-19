import { logger } from '../lib/logger';
import { runScan } from './scanner';
import type { QtgRequest, QtgResponse } from '../types/messages';

const VERSION = chrome.runtime.getManifest().version;

/**
 * 【定期実行は持たない】
 * ライトモード（トークン未設定）の枠は 60 req/h、1 スキャンは約 30 req。
 * 30 分間隔で回すと 60 req/h ちょうどで余裕がゼロになり、
 * 起動時スキャンや手動スキャンが 1 回入るだけで 429 に届く。
 * つまり「無料プランの設計どおりの挙動」がエラーとして記録される。
 *
 * 代わりに、拡張を入れたユーザーが自分のタイミングで走らせる形にする。
 * 連打しても <updated> が変わっていなければ API を 1 度も叩かないので、
 * 手動 2 回目以降は枠を消費しない。
 *
 * この判断により alarms 権限も不要になった（manifest.config.ts）。
 */

/**
 * スキャンの失敗を握りつぶさない。
 * ここで catch しないと unhandled rejection になり、原因が追いにくくなる。
 */
function safeScan(trigger: string): void {
  runScan().catch((error: unknown) => {
    logger.error('scan failed:', trigger, error);
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  logger.info('installed:', details.reason, 'version:', VERSION);
  // インストール直後だけは自動で 1 回走らせる。
  // 初回はキャッシュが空で必ず取得が走るため、ここが唯一の「約 30 req を使う自動実行」
  safeScan('installed');
});

chrome.runtime.onStartup.addListener(() => {
  // 定期実行ではないので、起動時に一度だけ追いつく。
  // フィードが変わっていなければ Atom への 1 リクエストで終わり、
  // API の枠（60 req/h）は消費しない
  safeScan('startup');
});

chrome.runtime.onMessage.addListener(
  (message: QtgRequest, _sender, sendResponse: (response: QtgResponse) => void) => {
    if (message.type === 'PING') {
      sendResponse({ type: 'PONG', version: VERSION });
    } else if (message.type === 'SCAN_NOW') {
      safeScan('manual');
      sendResponse({ type: 'SCAN_ACCEPTED' });
    }
    // 同期応答のみ。true を返すとチャネルが開きっぱなしになる
    return false;
  },
);

logger.info('service worker booted', VERSION);
