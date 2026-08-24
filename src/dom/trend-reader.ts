/**
 * 表示中のトレンドページからトレンド記事を読む。
 *
 * 【なぜ HTML を fetch しないのか】
 * Qiita は公式ヘルプでスクレイピングを禁じている。表示中の DOM を読むだけなら
 * リクエストが 1 本も増えないため、規約の解釈そのものが不要になる。
 * 禁止を迂回するのではなく、前提ごと消している。
 *
 * 【なぜ Atom フィードではないのか】
 * popular-items/feed と /trend の一致率は 70%（2026-08-20 実測。共通 21 件、
 * 各 9 件が相違）。フィードを見ている限り、ユーザーが画面で見ている 9 件は
 * 永久にスキャンされない。
 *
 * 【失敗の扱い】
 * 例外を投げない。読めなかった記事は黙って捨てる（設計上の約束 3）。
 * 誤った対象を操作するより、何もしない方が無害。
 */
import { SELECTORS, LINKS_PER_CARD, MAX_CARD_DEPTH } from './selectors';
import type { TrendItem } from '../types/domain';

/** https://qiita.com/{handle}/items/{itemId} だけを受ける */
const ITEM_URL_PATTERN = /^https:\/\/qiita\.com\/([^/?#]+)\/items\/([^/?#]+)/;

// 実測された item_id は英小文字＋数字だが、大文字も許容する。
const ITEM_ID_PATTERN = /^[0-9a-zA-Z]+$/;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** トレンドが載るページのパス。PRD が定める対象は / と /trend の 2 つ */
const TREND_PATHS = new Set(['/', '/trend']);

/**
 * トレンドを読んでよいページか。
 *
 * content script は https://qiita.com/* 全体に注入される（Phase 7・8 が記事ページや
 * ユーザーページでも DOM を操作するため）。だが **プロフィールページにはその人の
 * 記事一覧があり、記事リンクと <time> が揃っている**。素通しにすると、トレンドで
 * ない記事に 60 req/h の枠を使い、インデックスの中身も「トレンドの共起」では
 * なくなる。読む対象はページで絞る。
 */
export function isTrendPage(pathname: string): boolean {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return TREND_PATHS.has(normalized);
}

interface ParsedItemUrl {
  url: string;
  authorHandle: string;
  itemId: string;
}

/**
 * リンクの href から識別子を取り出す。
 *
 * 【形式検証を省かない理由】
 * ここを通った値はそのまま API のパスに入る。encodeURIComponent は "." を
 * エンコードしないため、".." が通ると /users/../items が /api/items に潰れ、
 * 別のエンドポイントを叩く。取得元が Atom フィードから DOM に変わっても、
 * 外部データであることは何も変わらない。
 */
function parseItemUrl(href: string): ParsedItemUrl | null {
  const matched = ITEM_URL_PATTERN.exec(href);
  if (matched === null) return null;
  const [, authorHandle, itemId] = matched;
  if (authorHandle === undefined || itemId === undefined) return null;
  if (!HANDLE_PATTERN.test(authorHandle) || !ITEM_ID_PATTERN.test(itemId)) return null;
  // クエリとハッシュを落とした正規形。UTM 付きと素の URL が別物にならないようにする
  return { url: `https://qiita.com/${authorHandle}/items/${itemId}`, authorHandle, itemId };
}

/**
 * リンクを含むカードを特定する。
 *
 * 【構造を前提にしない】
 * カードが article なのか li なのかを知らないまま動く。特定のタグやクラスに
 * 依存すると、リニューアルで壊れる。代わりに祖先を 1 段ずつ遡り、
 *
 *   記事リンクが LINKS_PER_CARD を超えた → カード境界を越えた。null
 *   time[datetime] があった               → これがカード
 *
 * とする。遡りすぎて全カードのコンテナに達すると必ずリンク数が超過するため、
 * **別の記事の投稿時刻を取り違えることが原理的に起きない。**
 *
 * 境界判定を先に行うこと。time を先に探すと、全カードのコンテナで他人の時刻を掴む。
 */
export function findCard(link: Element): Element | null {
  let current: Element | null = link.parentElement;
  for (let depth = 0; depth < MAX_CARD_DEPTH && current !== null; depth += 1) {
    if (current.querySelectorAll(SELECTORS.trendItemLink).length > LINKS_PER_CARD) return null;
    if (current.querySelector(SELECTORS.trendItemTime) !== null) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * 表示中のページからトレンド記事を読む。
 *
 * トレンド以外のページでは 0 件を返す。content script は qiita.com 全体に
 * 注入されるため、記事ページで 0 件になるのは正常な動作である。
 *
 * root を引数に取るのはテストで任意の DOM を渡せるようにするため
 * （selectors.ts の querySnackbarContainer と同じ思想）。
 */
export function readTrendItems(root: ParentNode = document): TrendItem[] {
  const byUrl = new Map<string, TrendItem>();

  for (const link of root.querySelectorAll<HTMLAnchorElement>(SELECTORS.trendItemLink)) {
    // href プロパティは絶対 URL に解決される。getAttribute は相対のことがある
    const parsed = parseItemUrl(link.href);
    if (parsed === null) continue;
    // 畳み込み自体は Map のキー（正規化 URL）が行う。この早期 continue は
    // 2 本目のリンクで findCard の祖先探索を繰り返さないための省略にすぎない
    if (byUrl.has(parsed.url)) continue;

    const card = findCard(link);
    if (card === null) continue;

    // 表示テキストは「2026年08月18日」でも datetime は "2026-08-17T17:44:41Z"。
    // UTC と JST で日付がずれるため textContent は読まない
    const publishedAt = card.querySelector(SELECTORS.trendItemTime)?.getAttribute('datetime') ?? '';
    if (publishedAt === '') continue;

    byUrl.set(parsed.url, { ...parsed, publishedAt });
  }

  return [...byUrl.values()];
}
