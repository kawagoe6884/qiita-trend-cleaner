/** content script / UI -> service worker */
export type QtgRequest = { type: 'PING' } | { type: 'SCAN_NOW' };

/**
 * service worker -> 呼び出し元。
 * SCAN_ACCEPTED は「受理した」だけを意味する。スキャンの完了は待たない
 * （待つとメッセージチャネルを開きっぱなしにする必要がある）。
 * 結果は storage の lastScanResult を見ること。
 */
export type QtgResponse = { type: 'PONG'; version: string } | { type: 'SCAN_ACCEPTED' };
