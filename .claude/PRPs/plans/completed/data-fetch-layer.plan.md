# Plan: データ取得層（Phase 4）

## Summary

Qiita の公式 Atom フィードと公式 API v2 だけを使って、組織票検出の入力データを揃える層を作る。スクレイピングは一切行わない。フィードの `<updated>` 変化検知でスキャンを起動し、トレンド 30 件の likers を `created_at` 付きで `chrome.storage.local` に格納する。レート枠（認証なし 60 req/h ／ 認証あり 1000 req/h）に応じて取得範囲を切り替える 2 モードを実装する。

## User Story

As a Qiita のトレンドを健全に読みたいユーザー,
I want 拡張機能が公式 API と公式フィードだけからいいねデータを集めてくれること,
So that 利用規約に触れずに組織票検出の材料が揃い、トークンを設定しなくても最低限の検出が動く。

## Problem → Solution

**現在**: Phase 2 の骨格のみ。service worker は PING に PONG を返すだけで、データ取得の手段が何も無い。

**完了後**: フィードの更新を検知して自動でスキャンが走り、トレンド 30 件分の liker レコード（`created_at` と User 情報つき）が storage に蓄積される。Phase 5 の検出エンジンはこの storage を読むだけで動く。

## Metadata

- **Complexity**: Large
- **Source PRD**: `.claude/PRPs/prds/qiita-trend-cleaner.prd.md`（改訂 4）
- **PRD Phase**: Phase 4 — データ取得層
- **Estimated Files**: 15（CREATE 13 / UPDATE 2）
- **Depends**: Phase 2（complete）
- **Parallel**: Phase 3（トークン設定 UI）と並行可能。結合点は `storage.getToken()` の型契約のみ

---

## UX Design

**Internal change — ユーザー可視の UX 変更なし。**

この層は service worker 内部で完結する。ユーザーが見るのは Phase 6（候補 UI）と Phase 7（DOM 非表示）から。ただし開発者が挙動を確認できるよう、logger による観測点だけは設ける。

### 観測可能な副作用

| 触点 | 変化 |
|---|---|
| service worker の DevTools コンソール | スキャン開始・完了・スキップ（`<updated>` 不変時）・レート枠の残量がログに出る |
| `chrome.storage.local` | `likeIndex` / `lastFeedUpdated` / `feedETag` / `lastScanAt` が書かれる |
| ネットワーク | フィードへの conditional GET が 30 分ごと。304 のときは以降の API 呼び出しが 0 件 |

---

## Mandatory Reading

実装前に必ず読むファイル。

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/types/domain.ts` | 全 89 行 | `LikeRecord` / `AccountIndexEntry` / `LocalState` が Phase 4 の出力契約。**この型に合わせて書く** |
| P0 | `src/lib/logger.ts` | 全 12 行 | ログの唯一の出口。`console` 直呼びは ESLint エラー |
| P0 | `src/lib/errors.ts` | 全 14 行 | `QtgError` の使いどころ。ネットワーク層の失敗はここ |
| P0 | `src/test/setup.ts` | 全 51 行 | chrome モックの実装。`storage` / `alarms` は既にモック済み。**`fetch` はモックされていないので各テストで用意する** |
| P1 | `src/background/service-worker.ts` | 全 20 行 | 唯一の UPDATE 対象エントリ。リスナー登録の書き方 |
| P1 | `src/dom/selectors.test.ts` | 1-20, 60-76 | テストの書き方（AAA コメント、`describe`/`it`、chrome モック往復） |
| P1 | `src/content/content-script.ts` | 9-33 | **境界で型ガードを使う**パターン。外部データ検証の手本 |
| P2 | `tsconfig.json` | 全 22 行 | `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / `verbatimModuleSyntax` が実装を縛る |
| P2 | `eslint.config.js` | 全 21 行 | `no-console` / `no-explicit-any` / `consistent-type-imports` が error |
| P2 | `.claude/PRPs/prds/qiita-trend-cleaner.prd.md` | 「レート制限の試算」「トークンの有無によるモード」「API 制約」 | モード定義の一次情報 |

---

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| MV3 service worker の DOMParser | [chromium-extensions グループ](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/0Af4aqQcY1Q) | **DOMParser は service worker で使えない**（スレッドセーフでないため）。回避策は offscreen document かサードパーティパーサ |
| service worker のライフサイクル | [Chrome Extensions: Service Workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers) | idle で終了する。**モジュールスコープの変数は消える**。状態は storage に置く |
| chrome.alarms | [chrome.alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms) | 30 分間隔は問題ない。`periodInMinutes` で繰り返し |
| Qiita API v2 | `https://qiita.com/api/v2/docs` | `per_page` 最大 100。`Rate-Limit` / `Rate-Remaining` / `Rate-Reset` ヘッダー |

### 実測結果（2026-08-19、このプロジェクトで直接確認）

```
KEY_INSIGHT: GET /api/v2/items/:item_id/likes は認証不要で HTTP 200 を返す
APPLIES_TO: qiita-client.ts のヘッダー構築、rate-budget.ts のモード判定
GOTCHA: レート枠が違う。認証なし 60 req/h（IP 単位）／ 認証あり 1000 req/h

KEY_INSIGHT: likes の応答は [{ created_at, user: {...} }] の配列。user に items_count /
             followers_count / description が同梱される
APPLIES_TO: LikeRecord と AccountIndexEntry の構築
GOTCHA: 空アカウント判定のための GET /api/v2/users/:user_id は不要。呼ぶとレートの無駄

KEY_INSIGHT: likes の応答ヘッダーに Total-Count と Link（rel="first"/"last"）がある
APPLIES_TO: ページネーション判定
GOTCHA: per_page=100 で Total-Count <= 100 なら追加ページ不要。1 req で判定できる

KEY_INSIGHT: フィードは ETag: W/"..." を返し、If-None-Match で 304（ボディ 0 バイト）
APPLIES_TO: feed-fetcher.ts
GOTCHA: Last-Modified は無い。If-Modified-Since は使えない。ETag のみ

KEY_INSIGHT: フィードの entry は id / published / updated / link / title / content / author の 7 要素
APPLIES_TO: atom-parser.ts
GOTCHA: <id> は tag:qiita.com,2005:PublicArticle/1234567 という内部の数値 ID で、
        **API で使う item_id ではない**。item_id は <link href> の URL から抜く

KEY_INSIGHT: ミュートしても likes API の結果は変わらない（OQ-7）
APPLIES_TO: 設計全体
GOTCHA: 実行前インデックスの保持は不要。素直に毎回取得してよい
```

### 実測した Atom の構造（値は合成）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="ja-JP" xmlns="http://www.w3.org/2005/Atom">
  <id>tag:qiita.com,2005:/popular-items/feed</id>
  <link rel="alternate" type="text/html" href="https://qiita.com/popular-items"/>
  <link rel="self" type="application/atom+xml" href="https://qiita.com/popular-items/feed"/>
  <title>Qiita - 人気の記事</title>
  <updated>2026-08-19T05:00:00+09:00</updated>   <!-- ★ ルートの updated。変化検知に使う -->
  <entry>
    <id>tag:qiita.com,2005:PublicArticle/1234567</id>   <!-- ★ item_id ではない -->
    <published>2026-08-16T11:59:04+09:00</published>
    <updated>2026-08-16T11:59:04+09:00</updated>        <!-- ★ ルートの updated と紛らわしい -->
    <link rel="alternate" type="text/html"
          href="https://qiita.com/example-author/items/0123456789abcdef0123"/>
    <title>記事タイトル</title>
    <content type="text">本文の抜粋…</content>
    <author>
      <name>example-author</name>
    </author>
  </entry>
  <!-- entry がちょうど 30 件 -->
</feed>
```

---

## Patterns to Mirror

コードベースから実際に抽出したパターン。これらに厳密に従う。

### NAMING_CONVENTION

```ts
// SOURCE: src/lib/logger.ts:4
const PREFIX = '[QTG]';                    // 定数: UPPER_SNAKE_CASE

// SOURCE: src/dom/selectors.ts:10,21
export const SELECTORS = { ... } as const; // オブジェクト定数: UPPER_SNAKE + as const
export const SNACKBAR_TEXT = { ... } as const;

// SOURCE: src/dom/selectors.ts:33,43
export function querySnackbarContainer(root: ParentNode = document): HTMLElement | null
export function readSnackbarMessage(root: ParentNode = document): string | null
// 関数: camelCase / 動詞始まり / 戻り値の型を明示

// SOURCE: src/types/domain.ts:11,19
export interface TrendItem { ... }         // 型: PascalCase
export type IsoDateTime = string;

// SOURCE: src/background/service-worker.ts / src/content/content-script.ts のファイル名
// エントリポイントは一意な basename にする（@crxjs のチャンク名衝突対策）。
// 本フェーズで追加するのはエントリではないので通常のケバブケースでよい
```

### ERROR_HANDLING

```ts
// SOURCE: src/lib/errors.ts:9-14
export class QtgError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'QtgError';
  }
}
// 使い方: new QtgError('feed fetch failed', { cause: error })
// cause は Error のネイティブプロパティ（ES2022）。パラメータプロパティで再宣言しない
```

```ts
// SOURCE: src/dom/selectors.ts:37-39
export function querySnackbarContainer(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SELECTORS.snackbarContainer);
}
// 取得の失敗は null を返す。例外を投げない（フェイルセーフ原則）
```

```ts
// SOURCE: src/content/content-script.ts:29-32
} catch (error) {
  // service worker 起動中などで失敗しうる。握りつぶさずログに残す
  logger.error('failed to reach service worker:', error);
}
// エラーは握りつぶさない。必ずログに残す。
// ★ この方針が Phase 2 のチャンク名衝突バグの発見に直結した
```

**本フェーズでの使い分け**

| 状況 | 扱い |
|---|---|
| フィード / API の HTTP エラー、パース失敗 | `QtgError` を投げる。呼び出し側（scanner）が catch してログし、そのスキャンを中断 |
| Atom の 1 entry が壊れている | その entry だけ `null` にしてスキップ。**スキャン全体は続行**（30 件中 1 件の欠損で全滅させない） |
| レート枠が尽きた | 例外にしない。取得済み分を保存して正常終了。次回スキャンで続きから |

### LOGGING_PATTERN

```ts
// SOURCE: src/lib/logger.ts:7-12
export const logger = {
  debug: (...args: unknown[]): void => console.debug(PREFIX, ...args),
  info:  (...args: unknown[]): void => console.info(PREFIX, ...args),
  warn:  (...args: unknown[]): void => console.warn(PREFIX, ...args),
  error: (...args: unknown[]): void => console.error(PREFIX, ...args),
};

// SOURCE: src/background/service-worker.ts:7,20
logger.info('installed:', details.reason, 'version:', VERSION);
logger.info('service worker booted', VERSION);
// メッセージは英語小文字、値をカンマ区切りで続ける
```

**GOTCHA**: Chrome は拡張機能内の `console.error` を「エラー」として収集し、`chrome://extensions` にバッジを出す。想定内の失敗に `logger.error` を使うと誤解を招く。**回復可能な失敗は `logger.warn`** を使う。

### TYPE_GUARD_PATTERN（外部データの検証）

```ts
// SOURCE: src/content/content-script.ts:13-17
function isPongResponse(value: unknown): value is QtgResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<QtgResponse>;
  return candidate.type === 'PONG' && typeof candidate.version === 'string';
}
// 別コンテキストから来る値は型アサーションではなく型ガードで受ける
// ★ Phase 4 では API レスポンスがこれに該当する。JSON.parse の結果を信用しない
```

### TEST_STRUCTURE

```ts
// SOURCE: src/dom/selectors.test.ts:1-19
import { describe, it, expect } from 'vitest';
import { SELECTORS, SNACKBAR_TEXT, readSnackbarMessage } from './selectors';

describe('SELECTORS', () => {
  it('CSS-in-JS のハッシュクラス名を含まない', () => {
    // Arrange
    const values: string[] = Object.values(SELECTORS);
    // Act
    const offenders = values.filter((value) => /\.style-/.test(value));
    // Assert
    expect(offenders).toEqual([]);
  });
});
// テスト名は日本語で「何ができるか」を書く。AAA をコメントで明示する
// import は拡張子なしの相対パス（'./selectors'）
```

```ts
// SOURCE: src/dom/selectors.test.ts:70-75
describe('chrome mock', () => {
  it('storage.local が set した値を get で返す', async () => {
    await chrome.storage.local.set({ lastFeedUpdated: '2026-08-18T17:00:00+09:00' });
    const result = await chrome.storage.local.get('lastFeedUpdated');
    expect(result).toEqual({ lastFeedUpdated: '2026-08-18T17:00:00+09:00' });
  });
});
// chrome は setup.ts が beforeEach で stubGlobal している。テスト側で用意しない
```

### STORAGE_MOCK（既存。拡張不要）

```ts
// SOURCE: src/test/setup.ts:44-46
storage: { local: createStorageArea(), sync: createStorageArea() },
alarms: { create: vi.fn(), clear: vi.fn(), onAlarm: { addListener: vi.fn() } },
// storage と alarms は既にモック済み。
// ★ fetch はモックされていない。各テストで vi.stubGlobal('fetch', ...) する
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/types/domain.ts` | UPDATE | `ScanMode` / `FeedSnapshot` / `ScanResult` を追加。`LocalState` に `lastScanAt` / `lastScanResult` を追加 |
| `src/types/messages.ts` | UPDATE | `SCAN_NOW` メッセージを追加（開発時の手動起動用） |
| `src/lib/storage.ts` | CREATE | `chrome.storage.local` の型付きアクセス。キーを直接文字列で触らせない |
| `src/lib/storage.test.ts` | CREATE | 既定値の補完と往復を検証 |
| `src/feed/atom-parser.ts` | CREATE | Atom を `TrendItem[]` に変換。**パースの知識をここだけに閉じ込める** |
| `src/feed/atom-parser.test.ts` | CREATE | 合成 XML で構造・欠損・順序を検証 |
| `src/feed/feed-fetcher.ts` | CREATE | conditional GET と `<updated>` 変化検知 |
| `src/feed/feed-fetcher.test.ts` | CREATE | 200 / 304 / ネットワークエラーを検証 |
| `src/api/rate-budget.ts` | CREATE | `Rate-*` ヘッダーの追跡、モード判定、枠の枯渇判定 |
| `src/api/rate-budget.test.ts` | CREATE | 枠計算と打ち切り判定を検証 |
| `src/api/qiita-client.ts` | CREATE | `likes` / `users/:id/items` / `authenticated_user` の呼び出し |
| `src/api/qiita-client.test.ts` | CREATE | ヘッダー構築、レスポンス検証、ページネーション判定 |
| `src/background/scanner.ts` | CREATE | スキャンのオーケストレーション。モードに応じた取得範囲の切替 |
| `src/background/scanner.test.ts` | CREATE | ライト/フル両モードの経路とレート枯渇時の打ち切り |
| `src/background/service-worker.ts` | UPDATE | `chrome.alarms` の登録と `onAlarm` / `onStartup` からのスキャン起動 |

## NOT Building

- **検出ロジック**（共起クラスタ判定・バースト判定・スコアリング）— Phase 5
- **トークン入力 UI**（Phase 3）。本フェーズは `storage.getToken()` で読むだけ
- **候補一覧・設定 UI**（Phase 6）／**DOM 非表示**（Phase 7）／**ミュート実行**（Phase 8）
- **HTML ページの取得**（恒久的に禁止。Atom と API のみ）
- **`GET /api/v2/users/:user_id`**（User 単体取得）— likes の応答に User が同梱されるため不要
- **offscreen document**（DOMParser 回避のため）— 自前パーサで足りる。フィード構造が複雑化したら再検討
- **リトライのバックオフ実装** — 本フェーズは「失敗したら次のスキャンに任せる」。30 分間隔があるため独自リトライは過剰
- **storage の保持期間管理（purge）** — `LocalState.purgeAfter` の型はあるが、実装は Phase 5 でインデックス構造が固まってから

---

## Step-by-Step Tasks

### Task 1: 型の追加

- **ACTION**: `src/types/domain.ts` に本フェーズが使う型を追加する
- **IMPLEMENT**:
  ```ts
  /** 取得の射程。トークンの有無ではなくレート枠から決まる */
  export type ScanMode = 'light' | 'full';

  /** フィード 1 回分の取得結果 */
  export interface FeedSnapshot {
    /** ルートの <updated>。変化検知のキー */
    feedUpdated: IsoDateTime;
    items: TrendItem[];
  }

  /** スキャン 1 回の結果サマリ。ログと Phase 6 の表示に使う */
  export interface ScanResult {
    mode: ScanMode;
    scannedItemCount: number;
    likeRecordCount: number;
    /** レート枠を使い切って打ち切ったか */
    truncated: boolean;
    startedAt: IsoDateTime;
    finishedAt: IsoDateTime;
  }
  ```
  `LocalState` に追加:
  ```ts
  /** 最後にスキャンした時刻 */
  lastScanAt?: IsoDateTime;
  /** 最後のスキャン結果 */
  lastScanResult?: ScanResult;
  ```
- **MIRROR**: NAMING_CONVENTION（PascalCase 型、JSDoc で「なぜ」を書く）
- **IMPORTS**: なし（同一ファイル内の `IsoDateTime` / `TrendItem` を使う）
- **GOTCHA**: `exactOptionalPropertyTypes: true` のため `lastScanAt?: IsoDateTime` に `undefined` を明示代入できない。値が無いときはキーごと省く
- **VALIDATE**: `npm run typecheck` がエラー 0

### Task 2: storage 層

- **ACTION**: `src/lib/storage.ts` を作る
- **IMPLEMENT**:
  ```ts
  import type { LocalState, LikeIndex, IsoDateTime, ScanResult } from '../types/domain';

  async function readState(): Promise<LocalState>            // get(null) + 既定値マージ
  export async function getToken(): Promise<string | null>
  export async function getFeedCache(): Promise<{ etag: string | null; lastUpdated: IsoDateTime | null }>
  export async function saveFeedCache(etag: string | null, lastUpdated: IsoDateTime): Promise<void>
  export async function getLikeIndex(): Promise<LikeIndex>
  export async function saveLikeIndex(index: LikeIndex): Promise<void>
  export async function saveScanResult(result: ScanResult): Promise<void>
  ```
- **MIRROR**: ERROR_HANDLING（storage の失敗は稀。例外はそのまま上げ、呼び出し側で catch してログ）
- **IMPORTS**: `import type { ... } from '../types/domain';`（**`import type` 必須** — `verbatimModuleSyntax`）
- **GOTCHA**:
  - `chrome.storage.local.get(null)` は全件を返す。キー指定より単純で、既定値マージが一箇所で済む
  - **service worker は idle で終了する。** モジュールスコープにキャッシュを持たない。毎回 storage を読む
  - `noUncheckedIndexedAccess: true` のため `index[handle]` は `AccountIndexEntry | undefined`。必ず存在チェックする
- **VALIDATE**: `npm run test` で `storage.test.ts` が通る

### Task 3: storage のテスト

- **ACTION**: `src/lib/storage.test.ts` を作る
- **IMPLEMENT**: 「未設定なら `getToken()` が null」「保存した ETag を読み戻せる」「`likeIndex` の既定値が `{}`」「保存→読み出しで内容が一致」
- **MIRROR**: TEST_STRUCTURE（AAA コメント、日本語のテスト名）
- **IMPORTS**: `import { describe, it, expect } from 'vitest';`
- **GOTCHA**: `chrome` は `setup.ts` が `beforeEach` で差し替える。テスト側で用意しない。ストアはテストごとに新品
- **VALIDATE**: `npm run test`

### Task 4: Atom パーサ

- **ACTION**: `src/feed/atom-parser.ts` を作る
- **IMPLEMENT**:
  ```ts
  /**
   * Atom フィードのパースの唯一の置き場。
   *
   * 【なぜ DOMParser を使わないか】
   * MV3 の service worker には DOMParser が存在しない（スレッドセーフでないため）。
   * offscreen document を挟む手もあるが、追加権限とライフサイクル管理を招く。
   * Qiita のフィードは要素 7 種の固定構造なので、正規表現で十分かつ壊れにくい。
   *
   * 【壊れたときの挙動】
   * entry 単位で失敗を切り離す。1 件壊れても残り 29 件は返す。
   */
  export function parseFeed(xml: string): FeedSnapshot | null
  export function parseEntry(entryXml: string): TrendItem | null   // 個別テストのため export
  ```
  - ルートの `<updated>` は **最初の `<entry>` より前**にあるものを取る
  - `item_id` と著者ハンドルは `<link rel="alternate" ... href="https://qiita.com/{handle}/items/{itemId}"/>` から抽出
  - `publishedAt` は entry の `<published>`
- **MIRROR**: ERROR_HANDLING（`selectors.ts` と同じ「取得失敗は null、例外を投げない」）
- **IMPORTS**: `import type { FeedSnapshot, TrendItem } from '../types/domain';`
- **GOTCHA**:
  - **`<id>` は `tag:qiita.com,2005:PublicArticle/1234567` という内部の数値 ID で、API の `item_id` ではない。** ここを取り違えると API が全件 404 になる
  - **ルートの `<updated>` と entry の `<updated>` は同名。** 素朴に全文検索すると混同する。`xml.indexOf('<entry>')` より前だけを対象にする
  - `<content>` に `<` や `&` がエスケープされて入る。**content は使わないので無視してよい**
  - 名前空間 `xmlns="http://www.w3.org/2005/Atom"` は付くが、要素名にプレフィックスは無い
- **VALIDATE**: `npm run test` で `atom-parser.test.ts` が通る

### Task 5: Atom パーサのテスト

- **ACTION**: `src/feed/atom-parser.test.ts` を作る
- **IMPLEMENT**: 合成 XML で以下を検証
  - ルートの `<updated>` を取れる（entry の `<updated>` と取り違えない）
  - `item_id` を `<link href>` から取れる（`<id>` の数値を使っていない）
  - 著者ハンドルを取れる
  - entry が 30 件なら 30 件返る
  - **1 件だけ `<link>` が欠けた XML で、残り 29 件が返る**
  - 空文字列・不正な XML で `null` を返し例外を投げない
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `import { describe, it, expect } from 'vitest';`
- **GOTCHA**: **フィクスチャに実データを使わない。** 実アカウント名・実 item_id はリポジトリに入れてはならない（CLAUDE.md の絶対制約）。`example-author` / `0123456789abcdef0123` のような合成値を使い、構造だけ実測に合わせる
- **VALIDATE**: `npm run test`

### Task 6: フィード取得（conditional GET と変化検知）

- **ACTION**: `src/feed/feed-fetcher.ts` を作る
- **IMPLEMENT**:
  ```ts
  export const FEED_URL = 'https://qiita.com/popular-items/feed';

  export type FeedFetchOutcome =
    | { kind: 'unchanged' }
    | { kind: 'updated'; snapshot: FeedSnapshot; etag: string | null };

  export async function fetchFeedIfChanged(): Promise<FeedFetchOutcome>
  ```
  1. `storage.getFeedCache()` から ETag を読む
  2. ETag があれば `If-None-Match` を付けて fetch
  3. **304 なら `{ kind: 'unchanged' }`**
  4. 200 ならパースし、`feedUpdated` が前回と同じなら `unchanged`、違えば `updated`
- **MIRROR**: ERROR_HANDLING（fetch 失敗は `QtgError`。scanner が catch）
- **IMPORTS**:
  ```ts
  import { logger } from '../lib/logger';
  import { QtgError } from '../lib/errors';
  import { parseFeed } from './atom-parser';
  import * as storage from '../lib/storage';
  import type { FeedSnapshot } from '../types/domain';
  ```
- **GOTCHA**:
  - **ETag は `W/"..."` の weak 形式。引用符ごとそのまま `If-None-Match` に入れる**（加工しない）
  - **304 のときボディは 0 バイト。** `response.text()` は空文字を返すのでパースしてはいけない。ステータスで分岐する
  - `Last-Modified` は返らない。`If-Modified-Since` を使わない
  - **ETag が変わっても `<updated>` が同じことがありうる**（本文の微修正など）。二段構えで判定する。PRD の設計意図はあくまで `<updated>` の変化検知
  - フィードは API 枠外（API エンドポイントではない）。`Rate-*` ヘッダーは付かない
- **VALIDATE**: `npm run test` で `feed-fetcher.test.ts` が通る

### Task 7: フィード取得のテスト

- **ACTION**: `src/feed/feed-fetcher.test.ts` を作る
- **IMPLEMENT**: `vi.stubGlobal('fetch', vi.fn())` で以下を検証
  - ETag 未保存なら `If-None-Match` を付けない
  - ETag 保存済みならヘッダーに付く
  - 304 応答で `{ kind: 'unchanged' }`、パーサが呼ばれない
  - 200 かつ `<updated>` が前回と同じなら `unchanged`
  - 200 かつ `<updated>` が変化したら `updated` で snapshot を返す
  - fetch が reject したら `QtgError` を投げる
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `import { describe, it, expect, vi } from 'vitest';`
- **GOTCHA**: `setup.ts` は `fetch` をモックしない。**各テストで `vi.stubGlobal` する。** `vite.config.ts` の `unstubGlobals: true` によりテスト間で自動復元される
- **VALIDATE**: `npm run test`

### Task 8: レート枠の管理

- **ACTION**: `src/api/rate-budget.ts` を作る
- **IMPLEMENT**:
  ```ts
  export const RATE_LIMIT_ANON = 60;
  export const RATE_LIMIT_AUTH = 1000;
  /** 枠を使い切る手前で止めるための余白 */
  export const RATE_SAFETY_MARGIN = 5;

  export interface RateState { limit: number; remaining: number; resetAt: number | null }

  export function readRateHeaders(headers: Headers): RateState | null
  export function decideMode(hasToken: boolean): ScanMode
  export function availableRequests(state: RateState | null, fallbackLimit: number): number
  ```
- **MIRROR**: NAMING_CONVENTION（`UPPER_SNAKE_CASE` 定数、純粋関数）
- **IMPORTS**: `import type { ScanMode } from '../types/domain';`
- **GOTCHA**:
  - **ヘッダー名は `Rate-Limit` / `Rate-Remaining` / `Rate-Reset`**（一般的な `X-RateLimit-*` ではない）。実測で確認済み
  - `Rate-Reset` は Unix 秒。ミリ秒ではない
  - **モードは「トークンの有無」から決めるが、実際の打ち切りは `Rate-Remaining` で行う。** 認証なしでも他の要因で枠が減っていることがある（IP 単位のため）
  - この層は純粋関数だけにする。storage も fetch も触らない（テストが楽になる）
- **VALIDATE**: `npm run test`

### Task 9: レート枠のテスト

- **ACTION**: `src/api/rate-budget.test.ts` を作る
- **IMPLEMENT**: ヘッダー欠損で `null`、正常な値のパース、`decideMode` の分岐、`availableRequests` が余白を引くこと、`remaining` が余白以下なら 0 を返すこと
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `import { describe, it, expect } from 'vitest';`
- **GOTCHA**: `new Headers({ 'Rate-Limit': '60' })` で組み立てる。ヘッダー名の大文字小文字は `Headers` が正規化する
- **VALIDATE**: `npm run test`

### Task 10: Qiita API クライアント

- **ACTION**: `src/api/qiita-client.ts` を作る
- **IMPLEMENT**:
  ```ts
  const API_BASE = 'https://qiita.com/api/v2';
  const PER_PAGE = 100;

  export interface ApiResponse<T> { data: T; rate: RateState | null; totalCount: number | null }

  export async function fetchLikes(itemId: string, token: string | null): Promise<ApiResponse<QiitaLike[]>>
  export async function fetchUserItems(handle: string, token: string | null): Promise<ApiResponse<QiitaItem[]>>
  export async function verifyToken(token: string): Promise<boolean>   // Phase 3 が使う
  ```
  レスポンスは**型ガードで検証してから**返す:
  ```ts
  function isQiitaLike(value: unknown): value is QiitaLike  // created_at と user.id を確認
  ```
- **MIRROR**: TYPE_GUARD_PATTERN（`isPongResponse` と同じ形）、ERROR_HANDLING（HTTP エラーは `QtgError`）
- **IMPORTS**:
  ```ts
  import { QtgError } from '../lib/errors';
  import { logger } from '../lib/logger';
  import { readRateHeaders } from './rate-budget';
  ```
- **GOTCHA**:
  - **トークンがあるときだけ `Authorization: Bearer <token>` を付ける。** 空文字や `Bearer null` を送ると 401 になる
  - `per_page=100` が上限。101 以上を指定するとエラー
  - **`Total-Count <= 100` なら追加ページ不要。** ヘッダーで判定し、無駄な 2 ページ目を取りに行かない
  - **likes の応答に `user` が同梱されている。** `GET /api/v2/users/:user_id` を呼んではならない（レートの無駄）
  - 401 / 403 はトークン無効。**`logger.error` ではなく `logger.warn`**（想定内の失敗。Chrome のエラーバッジを立てない）
  - 429 はレート超過。`QtgError` を投げて scanner に打ち切らせる
- **VALIDATE**: `npm run test`

### Task 11: API クライアントのテスト

- **ACTION**: `src/api/qiita-client.test.ts` を作る
- **IMPLEMENT**:
  - トークン null なら `Authorization` ヘッダーが付かない
  - トークンありなら `Bearer <token>` が付く
  - 正常な JSON 配列を `data` として返す
  - **`user` が欠けた要素を含む応答で、その要素だけ落として他は返す**
  - `Total-Count` を `totalCount` として返す
  - 401 で `QtgError`、429 で `QtgError`
  - `Rate-*` ヘッダーが `rate` に入る
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `import { describe, it, expect, vi } from 'vitest';`
- **GOTCHA**: `fetch` のモックは `Response` を返す形にする（`new Response(JSON.stringify(...), { headers })`）。`ok` / `status` / `headers` / `json()` が揃う
- **VALIDATE**: `npm run test`

### Task 12: スキャナ（オーケストレーション）

- **ACTION**: `src/background/scanner.ts` を作る
- **IMPLEMENT**:
  ```ts
  export async function runScan(): Promise<ScanResult | null>
  ```
  1. `fetchFeedIfChanged()` → `unchanged` なら `null` を返して終了（**API を 1 回も叩かない**）
  2. `storage.getToken()` → `decideMode(hasToken)`
  3. トレンド 30 件それぞれに `fetchLikes` を呼ぶ。各回で `Rate-Remaining` を見て、余白を切ったら打ち切って `truncated: true`
  4. フルモードなら、続けて著者ごとに `fetchUserItems` → 追加記事の `fetchLikes`
  5. 応答を `LikeRecord` / `AccountIndexEntry` に畳んで `LikeIndex` を作る
  6. `saveLikeIndex` / `saveFeedCache` / `saveScanResult`
- **MIRROR**: ERROR_HANDLING（1 記事の失敗はスキップして継続、致命的失敗のみ中断）、LOGGING_PATTERN
- **IMPORTS**:
  ```ts
  import { logger } from '../lib/logger';
  import { fetchFeedIfChanged } from '../feed/feed-fetcher';
  import { fetchLikes, fetchUserItems } from '../api/qiita-client';
  import { decideMode, availableRequests, RATE_LIMIT_ANON, RATE_LIMIT_AUTH } from '../api/rate-budget';
  import * as storage from '../lib/storage';
  import type { ScanResult, LikeIndex } from '../types/domain';
  ```
- **GOTCHA**:
  - **ライトモードでフルモードの取得範囲を走らせない。** 60 req/h で 120 req のスキャンは完走せず、中途半端なインデックスが残る（CLAUDE.md の設計上の約束 9）
  - **リクエストは直列にする。** 30 本を `Promise.all` で並べるとレート制限に一気に当たり、`Rate-Remaining` による打ち切り判断も効かない
  - **`feedUpdated` の保存はスキャン成功後に行う。** 先に保存すると、途中で失敗したときに「取得済み」と誤認して次回スキップされる
  - service worker は idle で終了する。**長いスキャンの途中で止まりうる。** 打ち切り時も取得済み分を保存し、次回に続きから積める形にする
  - `noUncheckedIndexedAccess` のため `index[handle]` は `undefined` を含む。`??=` で初期化する
- **VALIDATE**: `npm run test` で `scanner.test.ts` が通る

### Task 13: スキャナのテスト

- **ACTION**: `src/background/scanner.test.ts` を作る
- **IMPLEMENT**:
  - `unchanged` のとき `null` を返し、**API クライアントが 1 度も呼ばれない**
  - ライトモードで `fetchUserItems` が呼ばれない
  - フルモードで `fetchUserItems` が呼ばれる
  - `Rate-Remaining` が余白を切ったら打ち切り、`truncated: true` で返る
  - 1 記事の `fetchLikes` が失敗しても残りが処理される
  - `LikeIndex` がアカウント単位で畳まれている
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `vi.mock('../api/qiita-client')` などでモジュールを差し替える
- **GOTCHA**: `vi.mock` はファイル先頭に巻き上げられる。モック実装内でトップレベル変数を参照しない
- **VALIDATE**: `npm run test`

### Task 14: service worker への配線

- **ACTION**: `src/background/service-worker.ts` を UPDATE する
- **IMPLEMENT**:
  ```ts
  const SCAN_ALARM = 'qtg-scan';
  const SCAN_PERIOD_MINUTES = 30;

  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(SCAN_ALARM, { periodInMinutes: SCAN_PERIOD_MINUTES });
  });
  chrome.runtime.onStartup.addListener(() => { void safeScan(); });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SCAN_ALARM) void safeScan();
  });
  ```
  既存の `PING` / `PONG` は残し、`SCAN_NOW` を追加して手動起動できるようにする
- **MIRROR**: 既存 `service-worker.ts` のリスナー登録スタイル（`logger.info` で観測点を残す）
- **IMPORTS**: `import { runScan } from './scanner';`
- **GOTCHA**:
  - **`runScan` の失敗を握りつぶさない。** `safeScan` は内部で catch して `logger.error` する
  - `onInstalled` は更新時にも走る。`alarms.create` は同名なら上書きなので重複しない
  - **既存の `onMessage` は `return false`（同期応答）。** `SCAN_NOW` の結果を待たせずに「受理した」だけを同期で返し、結果は storage 経由で見る（チャネルを開きっぱなしにしない）
  - `manifest.config.ts` の `permissions` に `alarms` は既にある。追加不要
- **VALIDATE**: `npm run build` の後、`dist/` の配線を検証（下記）

### Task 15: 統合検証

- **ACTION**: ビルドして実機で確認する
- **IMPLEMENT**: 下記「Validation Commands」の Level 3〜4 を実行
- **GOTCHA**: **ビルド成功は「正しく動く」を意味しない。** Phase 2 では型・lint・テスト全通過でも service worker が一度も実行されていなかった。`dist/` の配線を必ず読む
- **VALIDATE**: service worker の DevTools にスキャンのログが出て、`chrome.storage.local` に `likeIndex` が入る

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| ルートの updated を取る | entry にも updated がある XML | ルート側の値 | ✅ 取り違えやすい |
| item_id を link から取る | `<id>` が数値、`<link>` が URL | URL 側の英数 ID | ✅ 最大の罠 |
| entry 30 件 | 30 entry の XML | 30 件の TrendItem | |
| 壊れた entry の切り離し | 1 件 `<link>` 欠損 | 29 件返る、例外なし | ✅ |
| 不正 XML | `'<not-xml'` | `null`、例外なし | ✅ |
| 304 応答 | `status: 304` | `unchanged`、パーサ未呼び出し | ✅ |
| updated 不変 | 200 だが同じ `<updated>` | `unchanged` | ✅ |
| ETag ヘッダー付与 | 保存済み ETag あり | `If-None-Match` が付く | |
| トークンなしのヘッダー | `token: null` | `Authorization` が付かない | ✅ |
| user 欠損の要素 | 一部に user なし | その要素だけ除外 | ✅ |
| レート枯渇 | `Rate-Remaining: 3` | 打ち切り、`truncated: true` | ✅ |
| ライトモードの範囲 | トークンなし | `fetchUserItems` 未呼び出し | ✅ |
| 401 応答 | `status: 401` | `QtgError`、`logger.warn` | ✅ |

### Edge Cases Checklist

- [x] 空入力（空文字 XML、空配列 JSON）
- [x] 最大サイズ（`Total-Count: 100` 到達時のページネーション判定）
- [x] 不正な型（`user` 欠損、`created_at` 欠損）
- [ ] 並行アクセス — **該当なし**。スキャンは直列で、alarms は同時発火しない
- [x] ネットワーク失敗（fetch reject、429、401）
- [x] 権限拒否（401 / 403 をトークン無効として扱う）

### カバレッジ方針

**閾値 80% を本フェーズの合格条件にする。** Phase 2 と違い、成果物の大半がロジックであるため。ただし `service-worker.ts`（配線のみ）は対象外でよい。

---

## Validation Commands

### Level 1: 静的解析

```bash
npm run typecheck
```
EXPECT: エラー 0

```bash
npm run lint
```
EXPECT: エラー 0。特に `no-console` / `no-explicit-any` / `consistent-type-imports` に違反がないこと

### Level 2: ユニットテスト

```bash
npm run test
```
EXPECT: 全テスト通過。新規テストファイル 7 本

### Level 3: ビルドと成果物の配線検証

```bash
npm run build
```
EXPECT: 成功

```bash
cat dist/service-worker-loader.js
```
EXPECT: `service-worker.ts-<hash>.js` を指している（**content-script のチャンクを指していないこと**）

```bash
grep -o 'getURL("[^"]*")' dist/assets/*loader*.js
```
EXPECT: `content-script.ts-<hash>.js` を指している

> **この Level 3 の配線検証は Phase 2 の教訓から追加した。** ビルド成功・型 OK・lint OK・テスト全通過でも、@crxjs のチャンク名衝突で service worker が一度も実行されないことがあった。

### Level 4: 実機確認

1. `chrome://extensions` で `dist/` を再読み込み
2. service worker の DevTools を**開いてから**リロードする（Chrome は開く前のログを保持しない）
3. 期待するログ:
   - `[QTG] service worker booted <version>`
   - `[QTG] scan skipped: feed unchanged` または `[QTG] scan finished: mode=light items=30 ...`
4. DevTools の Application → Storage → Extension Storage で `likeIndex` にアカウントが入っていることを確認
5. **2 回目のスキャンで `feed unchanged` になり、API が呼ばれないこと**を Network タブで確認

### Manual Validation

- [ ] トークン未設定で `mode=light` になり、`users/*/items` へのリクエストが 0 件
- [ ] `chrome.storage.local` に手でトークンを入れると `mode=full` になる
- [ ] `Rate-Remaining` がログに出ており、想定どおり減っている
- [ ] フィードが更新されていない時間帯に連続でスキャンしても API 呼び出しが増えない

---

## Acceptance Criteria

- [ ] Task 1〜15 完了
- [ ] Validation Level 1〜4 がすべて通過
- [ ] テストカバレッジ 80% 以上（`service-worker.ts` を除く）
- [ ] 型エラー 0 / lint エラー 0
- [ ] **PRD の Success signal**: 1 回のスキャンでトレンド 30 件分の likers が `created_at` 付きで storage に入る。かつ `<updated>` が変わらない限りスキャンが走らない

## Completion Checklist

- [ ] コードが既存パターンに従っている（logger 経由、`import type`、AAA テスト）
- [ ] エラー処理が使い分けられている（致命的 = `QtgError`、部分失敗 = スキップして継続）
- [ ] `logger.error` を想定内の失敗に使っていない（Chrome のエラーバッジ対策）
- [ ] テストのフィクスチャに**実アカウント名・実 item_id が含まれていない**
- [ ] ハードコードされた値が定数になっている（`FEED_URL` / `PER_PAGE` / `RATE_*`）
- [ ] スコープ外の実装が混入していない（検出ロジック・UI・purge）
- [ ] 追加の調査なしに実装できた（できなかった箇所は本計画に追記する）

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **`<id>` を item_id と誤用する** | **High** | High | 本計画の GOTCHA とテストで明示的に検証。`<id>` は数値、`item_id` は英数 20 文字 |
| Atom の構造変更でパーサが壊れる | Low | High | パースを `atom-parser.ts` 1 ファイルに隔離。`null` を返して例外を投げない設計で、壊れても拡張全体は死なない |
| ライトモードで 60 req/h を超える | Medium | Medium | `Rate-Remaining` を毎回読み、余白 5 で打ち切る。直列実行で暴走を防ぐ |
| service worker の idle 終了でスキャン中断 | Medium | Low | 取得済み分を保存し、`feedUpdated` は成功後にのみ保存。次回スキャンでやり直せる |
| **ライトモードで一次証拠のクラスタを検出できない（OQ-12）** | Unknown | High | **本フェーズでは判明しない。** Phase 5 で実データを流して確認する。本フェーズは「トレンド 30 件の likers が揃う」ところまでを保証する |
| フィードへのアクセス頻度が過剰と判断される（OQ-10） | Low | Medium | conditional GET により 304 のときの転送量は 0。30 分間隔は一般的な RSS リーダーと同等以下 |

## Notes

### モードの命名について

PRD 改訂 4 では「ライトモード / フルモード」としている。ユーザーからは「無料プラン / 有料プラン」という比喩で要望が出たが、**PRD に「広告・収益化をしない」決定がある**ため、課金を連想させない機能ベースの呼称を採用した。

### なぜ判定ロジックを 2 本持たないか

CLAUDE.md の設計上の約束 9 に対応する。ライトとフルの違いは **入力する記事集合だけ** にする。Phase 5 の検出エンジンは「記事集合を受け取って共起を判定する」1 本の関数であり、本フェーズはその入力を 2 通り作るだけ。ここを守らないと、閾値調整（Phase 9）を 2 回やる羽目になる。

### 本計画で確定した実測値の出所

すべて 2026-08-19 にこのプロジェクトから直接確認した。PRD 改訂 4 の「レート制限の試算」「API 制約」と同じ根拠であり、推測は含まない。ただし**一次証拠の記事 URL は `.gitignore` された `*.local.md` にのみ存在する**ため、本計画にも実装にも書かない。

### 記事化の素材（Phase 10 向け）

本フェーズは記事の題材になる論点を 3 つ含む。

1. **MV3 の service worker に DOMParser が無い** — 直感に反する制約。XML を扱う拡張は必ず踏む
2. **Atom の `<id>` が API の item_id ではない** — フィードと API で ID 体系が違う。気づかないと全件 404
3. **conditional GET が実際に 304 を返すことを実測した** — 「対応しているはず」ではなく確認した記録

---

*Generated: 2026-08-19*
*Source PRD: `.claude/PRPs/prds/qiita-trend-cleaner.prd.md` — Phase 4*
