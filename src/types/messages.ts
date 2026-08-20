import type { TrendItem } from './domain';

/**
 * content script / UI -> service worker
 *
 * TREND_ITEMS は「いまユーザーが見ている 30 件」を運ぶ。
 * service worker はトレンドを取りに行かないので、これが唯一のスキャン契機になる。
 */
export type QtgRequest = { type: 'PING' } | { type: 'TREND_ITEMS'; items: TrendItem[] };

/**
 * service worker -> 呼び出し元。
 * SCAN_ACCEPTED は「受理した」だけを意味する。スキャンの完了は待たない
 * （待つとメッセージチャネルを開きっぱなしにする必要がある）。
 * 結果は storage の lastScanResult を見ること。
 */
export type QtgResponse = { type: 'PONG'; version: string } | { type: 'SCAN_ACCEPTED' };
