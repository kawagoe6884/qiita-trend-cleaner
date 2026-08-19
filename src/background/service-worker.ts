import { logger } from '../lib/logger';
import { runScan } from './scanner';
import type { QtgRequest, QtgResponse } from '../types/messages';

const VERSION = chrome.runtime.getManifest().version;

/** スキャンの定期実行。PRD の設計どおり 30 分間隔で <updated> の変化を見に行く */
const SCAN_ALARM = 'qtg-scan';
const SCAN_PERIOD_MINUTES = 30;

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
  // 同名の alarm は上書きされるため、更新時に重複登録されない
  void chrome.alarms.create(SCAN_ALARM, { periodInMinutes: SCAN_PERIOD_MINUTES });
  safeScan('installed');
});

chrome.runtime.onStartup.addListener(() => {
  // 更新時刻を逃していても、起動時に追いつける
  safeScan('startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SCAN_ALARM) safeScan('alarm');
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
