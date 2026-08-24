import { logger } from '../lib/logger';
import { INJECTION_MARKER } from '../dom/selectors';
import { readTrendItems, isTrendPage } from '../dom/trend-reader';
import {
  hideJudgedAuthors,
  unhideAll,
  countHidden,
  renderNotice,
  clearHighlights,
} from '../dom/hider';
import { muteAuthor, MUTE_INTERVAL_MS } from '../dom/muter';
import * as storage from '../lib/storage';
import type { AccountHandle, MuteOutcome } from '../types/domain';
import type { QtgRequest, QtgResponse } from '../types/messages';

function markInjected(version: string): void {
  document.documentElement.dataset[INJECTION_MARKER] = version;
}

/** QtgResponse はユニオンなので、PONG だけに絞った型を用意する */
type PongResponse = Extract<QtgResponse, { type: 'PONG' }>;

/**
 * service worker からの応答を実行時に検証する。
 * 別コンテキストから来る値なので、型アサーションではなく型ガードで受ける。
 */
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

/**
 * 「表示する」を押して手で戻した件数。0 なら通常どおり隠れている状態。
 *
 * **この状態を持たないと戻す手段が無くなる。**「表示する」を押したあと
 * ユーザーが「妥当」を押し直しても、**評価は既に valid なので storage の値が
 * 変わらず、onChanged が発火しない**（Chrome は値が実際に変わったときだけ
 * 発火する）。何も起きないように見えるので、トグルで対称にする。
 */
let shownByUser = 0;

/** 通知を今の状態に合わせて描き直す */
function refreshNotice(): void {
  if (shownByUser > 0) {
    renderNotice(shownByUser, onToggleHiding, document, 'shown');
    return;
  }
  renderNotice(countHidden(), onToggleHiding, document, 'hidden');
}

function onToggleHiding(): void {
  if (shownByUser > 0) {
    // 「隠す」— 評価に従って隠し直す
    shownByUser = 0;
    void applyHiding();
    return;
  }
  // 「表示する」— そのページだけ戻す。リロードすれば評価に従って隠れ直す
  shownByUser = unhideAll();
  refreshNotice();
}

/**
 * 評価済みの候補を隠す。
 *
 * 【差分を追わず、いったん全部戻してから再適用する】
 * 「誤り」に押し直したときに戻す必要がある。どの著者が増減したかを追うより、
 * 全部戻して付け直す方が単純で取りこぼしが無い。件数は 30 件程度で、
 * 表示中の DOM を触るだけなのでコストも小さい。
 */
async function applyHiding(): Promise<void> {
  if (!isTrendPage(location.pathname)) return;

  try {
    const feedback = await storage.getFeedback();
    unhideAll();
    // 背景の目印もここで消す。評価が false_positive に変わったカードに
    // 色が残ると、「妥当と判断した」という誤った印を出し続ける
    clearHighlights();
    const result = hideJudgedAuthors(feedback);
    if (result.hidden > 0) {
      logger.info('hidden:', result.hidden, 'authors:', result.authors.length);
    }
    refreshNotice();
  } catch (error) {
    // storage が読めなくても、ページの表示そのものは壊さない。
    // 隠せないだけなので想定内（設計上の約束 11）
    logger.debug('failed to apply hiding:', error);
  }
}

/**
 * 評価の変更に追従する。**message passing を使わない。**
 *
 * ポップアップと content script は別コンテキストだが storage は共有されている。
 * これでポップアップの「妥当 / 誤り」を押した瞬間に、開いているトレンドページへ
 * 反映される（Phase 6 でポップアップに入れたのと同じ手）。
 */
function watchFeedback(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('feedback' in changes)) return;
    // 評価が変わったら隠し直す。「表示する」で戻していた状態は解除する
    shownByUser = 0;
    void applyHiding();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ミュートを直列につなぐ。**デバウンスでは足りない。**
 *
 * タイマーは発火した瞬間に手を離すので、実行中の処理は次を止めない。
 * ミュートは Qiita の DOM を実際に操作するため、2 件が重なると片方の
 * メニューが開いたまま別のカードを触ることになる。
 *
 * 間隔を空けるのは、手動操作と同程度の負荷に留めるため。
 * 失敗しても列は止めない（成否どちらでも sleep を挟む）。
 */
let muteQueue: Promise<unknown> = Promise.resolve();

function enqueueMute(handle: AccountHandle): Promise<MuteOutcome> {
  const result = muteQueue.then(() => muteAuthor(handle));
  muteQueue = result.then(
    () => sleep(MUTE_INTERVAL_MS),
    () => sleep(MUTE_INTERVAL_MS),
  );
  return result;
}

/** ポップアップから来る値なので、型アサーションではなく型ガードで受ける */
function isMuteRequest(value: unknown): value is Extract<QtgRequest, { type: 'MUTE_AUTHOR' }> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<{ type: unknown; handle: unknown }>;
  return candidate.type === 'MUTE_AUTHOR' && typeof candidate.handle === 'string';
}

/**
 * ミュートの依頼を受ける。
 *
 * 【なぜ storage.onChanged ではなくメッセージなのか】
 * 評価が既に valid なら storage の値が変わらず、onChanged が発火しない。
 * **押し直しでのやり直しができなくなる。**ミュートは状態の同期ではなく操作で、
 * 冪等に再実行できる必要がある。これがリトライ機構を持たずに済む根拠でもある。
 *
 * 【トレンドページ以外では応じない】
 * プロフィールページにも記事一覧と <time> が揃っているので、素通しにすると
 * トレンドでないカードを操作しうる。エラーが出ないことと、やるべきでないことを
 * やらないことは別物。
 *
 * 【扱わないメッセージで true を返さない】
 * true を返すとチャネルが開いたままになり、他のリスナーの応答が捨てられる。
 */
function listenForMute(): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isMuteRequest(message)) return undefined;
    const { handle } = message;
    const respond = (outcome: MuteOutcome): void => {
      const response: QtgResponse = { type: 'MUTE_RESULT', handle, outcome };
      sendResponse(response);
    };

    if (!isTrendPage(location.pathname)) {
      respond('not-on-page');
      return undefined;
    }

    enqueueMute(handle)
      .then((outcome) => {
        // 失敗はすべて想定内（カードが無い・既にミュート済み・Qiita の変更）。
        // warn / error に載せると「拡張が壊れている」と読まれる
        if (outcome === 'muted') logger.info('muted:', handle);
        else logger.debug('mute skipped:', handle, outcome);
        respond(outcome);
      })
      .catch((error: unknown) => {
        // muteAuthor は投げない設計だが、ポップアップを待たせ続けない
        logger.debug('mute failed:', handle, error);
        respond('menu-unavailable');
      });
    return true; // 非同期で応答する
  });
}

logger.info('content script ready');
void ping();
// 隠す前に読む。隠したカードも DOM には残るので実害は無いが、順序を明示しておく
void sendTrendItems();
watchFeedback();
listenForMute();
void applyHiding();
