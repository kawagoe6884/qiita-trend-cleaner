/**
 * Qiita の Atom フィードをパースする唯一の置き場。
 *
 * 【なぜ DOMParser を使わないか】
 * MV3 の service worker には DOMParser が存在しない（スレッドセーフでないため）。
 * offscreen document を挟む手もあるが、追加権限とライフサイクル管理を招く。
 * Qiita のフィードは要素 7 種の固定構造なので、正規表現で十分かつ依存も増えない。
 *
 * 【壊れたときの挙動】
 * selectors.ts と同じフェイルセーフ原則。取得できなければ null を返し、例外は投げない。
 * entry 単位で失敗を切り離すので、1 件壊れても残りは返す。
 *
 * 【実測した構造（2026-08-19）】
 * <feed>
 *   <updated>2026-08-19T05:00:00+09:00</updated>   ← ルート。変化検知に使う
 *   <entry>
 *     <id>tag:qiita.com,2005:PublicArticle/1234567</id>   ← API の item_id ではない
 *     <published>2026-08-16T11:59:04+09:00</published>
 *     <updated>...</updated>                        ← ルートと同名。取り違え注意
 *     <link rel="alternate" type="text/html"
 *           href="https://qiita.com/example-author/items/0123456789abcdef0123"/>
 *     <title>...</title><content type="text">...</content>
 *     <author><name>example-author</name></author>
 *   </entry>
 * </feed>
 */
import type { FeedSnapshot, TrendItem } from '../types/domain';

/**
 * 記事へのリンク。**item_id と著者ハンドルはここから取る。**
 * <id> は tag:qiita.com,2005:PublicArticle/1234567 という内部の数値 ID で、
 * API のパスには使えない。取り違えると全件 404 になる。
 * <author><name> ではなく URL 側を使うのは、URL のパスが API のハンドルと同一だから。
 *
 * 【実データの罠】href には UTM パラメータが付く。
 *   https://qiita.com/{handle}/items/{itemId}?utm_campaign=...&amp;utm_medium=...
 * item_id の直後に " を期待するとマッチせず、entry が全件落ちる。
 * クエリは [^"]* で読み飛ばし、キャプチャ 1 はクエリを除いた正規化 URL とする。
 */
const ITEM_LINK_PATTERN =
  /<link[^>]*\brel="alternate"[^>]*\bhref="(https:\/\/qiita\.com\/([^/"]+)\/items\/([^/"?#]+))[^"]*"/;

/**
 * パーサが返す値の形式を保証する。
 *
 * ここを通った itemId / authorHandle はそのまま API のパスに入る。
 * 検証しないと ".." や "?" を含む値が URL 階層を書き換え、
 * 意図しないエンドポイントを叩きうる（フィードは外部データである）。
 *
 * 長さは固定しない。実測では item_id は 20 文字だが、
 * 桁数が変わったときに正当な記事を落とすほうが害が大きい。
 */
// 実測された item_id は英小文字＋数字だが、大文字も許容する。
// 観測は 1 回きりであり、厳しすぎると正当な記事を落とすほうが害が大きい。
// qiita-client の SAFE_PATH_SEGMENT とも整合させる。
const ITEM_ID_PATTERN = /^[0-9a-zA-Z]+$/;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]+$/;

const PUBLISHED_PATTERN = /<published>([^<]+)<\/published>/;
const UPDATED_PATTERN = /<updated>([^<]+)<\/updated>/;

/**
 * entry 1 件を TrendItem に変換する。
 * link や published が無ければ null（呼び出し側がスキップする）。
 */
export function parseEntry(entryXml: string): TrendItem | null {
  const link = ITEM_LINK_PATTERN.exec(entryXml);
  const url = link?.[1];
  const authorHandle = link?.[2];
  const itemId = link?.[3];
  if (!url || !authorHandle || !itemId) return null;
  // 形式が想定と違うものは API へ渡さない
  if (!ITEM_ID_PATTERN.test(itemId) || !HANDLE_PATTERN.test(authorHandle)) return null;

  const publishedAt = PUBLISHED_PATTERN.exec(entryXml)?.[1];
  if (!publishedAt) return null;

  return { itemId, url, authorHandle, publishedAt };
}

/**
 * フィード全体をパースする。
 * ルートの <updated> が取れなければ null（変化検知の起点が無いため続行不能）。
 */
export function parseFeed(xml: string): FeedSnapshot | null {
  // ルートの <updated> は最初の <entry> より前にある。
  // 全文検索すると entry 側と混同するため、範囲を先に切る。
  const firstEntryAt = xml.indexOf('<entry>');
  const head = firstEntryAt === -1 ? xml : xml.slice(0, firstEntryAt);
  const feedUpdated = UPDATED_PATTERN.exec(head)?.[1];
  if (!feedUpdated) return null;

  const items: TrendItem[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const body = match[1];
    if (!body) continue;
    const item = parseEntry(body);
    // 壊れた entry は捨てる。30 件中 1 件の欠損でスキャン全体を失敗させない
    if (item) items.push(item);
  }

  return { feedUpdated, items };
}
