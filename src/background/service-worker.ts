import { logger } from '../lib/logger';
import type { QtgRequest, QtgResponse } from '../types/messages';

const VERSION = chrome.runtime.getManifest().version;

chrome.runtime.onInstalled.addListener((details) => {
  logger.info('installed:', details.reason, 'version:', VERSION);
});

chrome.runtime.onMessage.addListener(
  (message: QtgRequest, _sender, sendResponse: (response: QtgResponse) => void) => {
    if (message.type === 'PING') {
      sendResponse({ type: 'PONG', version: VERSION });
    }
    // 同期応答のみ。true を返すとチャネルが開きっぱなしになる
    return false;
  },
);

logger.info('service worker booted', VERSION);
