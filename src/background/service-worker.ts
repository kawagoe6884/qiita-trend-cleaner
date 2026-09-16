import { logger } from '../lib/logger';
import * as storage from '../lib/storage';
import { runScan } from './scanner';
import type { QtgRequest, QtgResponse } from '../types/messages';
import type { TrendItem } from '../types/domain';

const VERSION = chrome.runtime.getManifest().version;

/**
 * 【自動スキャンも定期実行も持たない】
 * 起動契機は「ユーザーがトレンドページを開いたとき」だけ。
 *
 * 定期実行を持たない理由: ライトモード（トークン未設定）の枠は 60 req/h、
 * 1 スキャンは約 30 req。30 分間隔で回すと枠ちょうどになり、起動時スキャンが
 * 1 回入るだけで 429 に届く。「無料プランの設計どおりの挙動」がエラーとして
 * 記録されることになる。この判断により alarms 権限も不要になった。
 *
 * 起動時スキャンも持たない理由: トレンドを取りに行かなくなったため、
 * ページを開いていないときに走らせても見に行く先が無い。
 */

/**
 * 別コンテキストから来た値が TrendItem の形をしているか検証する。
 *
 * trend-reader が検証済みでも、**メッセージ境界を越えたら再検証する**。
 * ここを通った itemId / authorHandle はそのまま API のパスに入るため、
 * 送り手が本当に自分の content script だったかを型で保証できない以上、
 * 受け側で確かめるしかない。
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

function isTrendItem(value: unknown): value is TrendItem {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TrendItem>;
  return (
    typeof candidate.itemId === 'string' &&
    SAFE_SEGMENT.test(candidate.itemId) &&
    typeof candidate.authorHandle === 'string' &&
    SAFE_SEGMENT.test(candidate.authorHandle) &&
    typeof candidate.publishedAt === 'string' &&
    candidate.publishedAt.length > 0 &&
    // url は API のパスには入らないが、Phase 6 が候補一覧でリンクとして描画する。
    // typeof チェックだけだと javascript: を持ち込める。検証済みの 2 つから
    // 組み立て直して一致を見れば、新しい正規表現を増やさずに閉じられる
    candidate.url === `https://qiita.com/${candidate.authorHandle}/items/${candidate.itemId}`
  );
}

function isTrendItems(value: unknown): value is TrendItem[] {
  return Array.isArray(value) && value.every(isTrendItem);
}

/**
 * スキャンの失敗を握りつぶさない。
 * ここで catch しないと unhandled rejection になり、原因が追いにくくなる。
 */
function safeScan(items: TrendItem[], trigger: string): void {
  runScan(items).catch((error: unknown) => {
    logger.error('scan failed:', trigger, error);
  });
}

/**
 * 届いた一覧を「いま誰がトレンドに出ているか」の記録として残す。
 *
 * 【スキャンとは別の経路にしてある】
 * `runScan` はレート枠や既知判定で早々に何もせず戻ることがあるが、この記録は
 * **API を 1 本も使わない**ので、スキャンの成否と無関係に毎回残すのが正しい。
 *
 * 【`now` をここで取る】
 * 撮影時刻はメッセージを**受け取った瞬間**であって、スキャンが終わった時刻では
 * ない。`runScan` は数秒かかりうるので、その間にユーザーがミュートを押すと、
 * 「押す前のスナップショット」を根拠に押した記録を消してしまう。
 */
function safeRecordTrend(items: TrendItem[]): void {
  const now = new Date();
  const handles = items.map((item) => item.authorHandle);
  void (async () => {
    const snapshot = await storage.saveTrendSnapshot(handles, now);
    // ここに居る著者は、その時点でミュートされていない（TrendSnapshot の JSDoc）
    await storage.forgetMuteConfirmation(handles, snapshot.at);
  })().catch((error: unknown) => {
    // 記録に失敗しても検出は動く。想定内なので debug に留める（約束 11）
    logger.debug('trend snapshot failed:', error);
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  // ここでスキャンしない。トレンドページを開いた時点で content script が知らせる
  logger.info('installed:', details.reason, 'version:', VERSION);
});

chrome.runtime.onMessage.addListener(
  (message: QtgRequest, _sender, sendResponse: (response: QtgResponse) => void) => {
    if (message.type === 'PING') {
      sendResponse({ type: 'PONG', version: VERSION });
    } else if (message.type === 'TREND_ITEMS') {
      if (isTrendItems(message.items)) {
        safeRecordTrend(message.items);
        safeScan(message.items, 'trend page');
        sendResponse({ type: 'SCAN_ACCEPTED' });
      } else {
        // 壊れたメッセージは受理しない。想定内の防御なので debug
        logger.debug('rejected malformed TREND_ITEMS');
      }
    }
    // 同期応答のみ。true を返すとチャネルが開きっぱなしになる
    return false;
  },
);

logger.info('service worker booted', VERSION);
