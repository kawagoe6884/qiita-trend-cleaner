import type { AccountHandle, MuteOutcome, TrendItem } from './domain';

/**
 * content script / UI -> service worker / content script
 *
 * TREND_ITEMS は「いまユーザーが見ている 30 件」を運ぶ。
 * service worker はトレンドを取りに行かないので、これが唯一のスキャン契機になる。
 *
 * MUTE_AUTHOR だけは宛先が違う。**ポップアップから content script へ直接**
 * 送る（chrome.tabs.sendMessage）。service worker は経由しない。
 *
 * 【なぜ storage.onChanged で代用しないのか】
 * 評価が既に valid なら値が変わらず、chrome.storage.onChanged が発火しない
 * （Chrome は値が実際に変わったときだけ発火する）。**押し直しでのやり直しが
 * できなくなる。**ミュートは状態の同期ではなく操作である。
 * 非表示（状態）は onChanged、ミュート（操作）はメッセージ、と経路を分ける。
 */
export type QtgRequest =
  | { type: 'PING' }
  | { type: 'TREND_ITEMS'; items: TrendItem[] }
  | { type: 'MUTE_AUTHOR'; handle: AccountHandle };

/**
 * service worker -> 呼び出し元。
 * SCAN_ACCEPTED は「受理した」だけを意味する。スキャンの完了は待たない
 * （待つとメッセージチャネルを開きっぱなしにする必要がある）。
 * 結果は storage の lastScanResult を見ること。
 */
export type QtgResponse =
  | { type: 'PONG'; version: string }
  | { type: 'SCAN_ACCEPTED' }
  /** handle を載せるのは、別コンテキストから来る値を型ガードで検証するため */
  | { type: 'MUTE_RESULT'; handle: AccountHandle; outcome: MuteOutcome };
