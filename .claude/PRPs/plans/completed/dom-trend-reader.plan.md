# Plan: データ取得層（DOM 版）— Phase 4b

## Summary

Atom フィードを廃止し、**ユーザーが開いているトレンドページの DOM** からトレンド 30 件を読む。追加リクエストはゼロ。あわせてレート枠の予測的な予算管理をやめ、**429 が返るまで走って返ったら止める**方式へ変える。

検出エンジン（`src/detect/`）はインデックスを受け取るだけで出所を問わない設計のため、**この作り直しの影響を受けない**。

## User Story

As a Qiita のトレンド面を日常的に開く読者,
I want 拡張が「いま自分が見ている 30 件」を対象に判定してほしい,
So that 画面に出ているのに一度もスキャンされない記事が無くなる。

## Problem → Solution

**現在**: Atom フィード（`popular-items/feed`）の 30 件を判定している。しかし 2026-08-20 の実測で、フィードと `/trend` は**一致率 70% の別集合**と判明した。共通 21 件、各 9 件が相違。**ユーザーが見ている 9 件は永久にスキャンされない。**

**目標**: content script が表示中ページの DOM を読み、その 30 件を判定対象にする。

## Metadata

- **Complexity**: Large
- **Source PRD**: `.claude/PRPs/prds/qiita-trend-cleaner.prd.md`（改訂 6）
- **PRD Phase**: Phase 4b（データ取得層 DOM 版）— depends on 2, 5
- **Estimated Files**: 新規 2 / 変更 15 / 削除 4

---

## UX Design

### Before

```
┌────────────────────────────────────────────┐
│ ユーザーは何もしていない                   │
│   ↓                                        │
│ 拡張がインストール時／ブラウザ起動時に     │
│ Atom フィードを取りに行く                  │
│   ↓                                        │
│ フィードの 30 件を判定                     │
│                                            │
│ → 画面の 9 件は永久に見られない            │
└────────────────────────────────────────────┘
```

### After

```
┌────────────────────────────────────────────┐
│ ユーザーが qiita.com/trend を開く          │
│   ↓                                        │
│ content script が画面の 30 件を読む        │
│ （追加リクエスト 0）                       │
│   ↓                                        │
│ 未取得の記事だけ likes API                 │
│   ↓ 429 が返ったらそこで停止               │
│   ↓                                        │
│ 判定 → 候補をログと storage へ             │
│                                            │
│ → 判定対象＝画面に出ている 30 件           │
└────────────────────────────────────────────┘
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| スキャンの契機 | `onInstalled` / `onStartup` / `SCAN_NOW` | **トレンドページを開いたとき** | 自動スキャンは見に行く先を失う |
| リロード時の消費 | フィード不変なら 0 req | **0 req**（全件インデックス済み） | 効果は同じだが理由が変わる |
| 429 到達時 | 手前で止まる（`truncated`） | **429 まで走って停止**、`Rate-Reset` を記録 | Phase 6 でバッジ表示 |
| ユーザーの操作 | 変化なし | 変化なし | 4b に UI は無い |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/dom/selectors.ts` | all | **セレクタの唯一の置き場。** ハッシュクラス禁止の理由とフェイルセーフの書き方 |
| P0 | `src/dom/selectors.test.ts` | 1-20 | **機械的な検査。** 新しいセレクタもこれを通る必要がある |
| P0 | `src/background/scanner.ts` | all | `runScan` の構造。フィード取得と予算管理を外す対象 |
| P0 | `src/feed/atom-parser.ts` | 29-79 | **削除するが、URL から handle / itemId を取る正規表現は移植する** |
| P1 | `src/content/content-script.ts` | all | メッセージ送信と型ガードの書き方 |
| P1 | `src/types/messages.ts` | all | 判別可能ユニオンの定義 |
| P1 | `src/api/rate-budget.ts` | all | 何を残し何を消すか |
| P2 | `src/detect/like-index.ts` | 1-45 | 純粋関数層の書き方（`trend-reader` も同じ思想） |

## External Documentation

外部研究は不要。**DOM API と既存の内部パターンだけで完結する。**

```
KEY_INSIGHT: <time datetime="..."> は HTML 標準。Qiita は秒精度の ISO 8601（UTC）を入れている
APPLIES_TO: trend-reader.ts の投稿時刻取得
GOTCHA: 表示テキストは「2026年08月18日」だが datetime は "2026-08-17T17:44:41Z"。
        UTC と JST で日付がずれる。必ず datetime 属性を使い、textContent は読まない
```

```
KEY_INSIGHT: 1 カードにつき a[href*="/items/"] が 2 本ある（タイトル付きと無し）
APPLIES_TO: trend-reader.ts の重複排除
GOTCHA: 実測で links=60 / 記事 30 件。href で dedup しないと 2 倍に膨らむ
```

---

## Patterns to Mirror

### セレクタの定義（SELECTOR_DEFINITION）

```ts
// SOURCE: src/dom/selectors.ts:1-17
/**
 * Qiita の DOM セレクタの唯一の置き場。
 *
 * 【禁止】CSS-in-JS が生成したハッシュクラス名（.style-5ctx60 等）を書かないこと。
 *        Qiita がビルドし直すたびに変わるため、次のデプロイで確実に壊れる。
 *        selectors.test.ts が機械的に検査している。
 *
 * 【使ってよいもの】id プレフィックス / ARIA 属性 / テキスト一致 / 安定した data 属性
 */
export const SELECTORS = {
  /** Snackbar のコンテナ。React コンポーネント名は安定、uuid サフィックスのみ可変 */
  snackbarContainer: '[id^="Snackbar-react-component-"]',
  /** ARIA ライブリージョン。属性は事実上の契約で変更されにくい */
  snackbarLiveRegion: '[aria-live="polite"][aria-atomic="true"]',
} as const;
```

### DOM 取得のフェイルセーフ（DOM_FAILSAFE）

```ts
// SOURCE: src/dom/selectors.ts:28-45
/**
 * Snackbar のコンテナを取得する。
 * 見つからなければ null を返し、例外は投げない（フェイルセーフ原則）。
 */
export function querySnackbarContainer(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SELECTORS.snackbarContainer);
}
```

**要点**: `root: ParentNode = document` を引数に取る。テストで任意の DOM を渡せる。

### URL からの識別子抽出（URL_PARSE）

```ts
// SOURCE: src/feed/atom-parser.ts:40-73（削除するが移植する）
const ITEM_LINK_PATTERN =
  /<link[^>]*\brel="alternate"[^>]*\bhref="(https:\/\/qiita\.com\/([^/"]+)\/items\/([^/"?#]+))[^"]*"/;

// 実測された item_id は英小文字＋数字だが、大文字も許容する。
const ITEM_ID_PATTERN = /^[0-9a-zA-Z]+$/;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]+$/;

  // 形式が想定と違うものは API へ渡さない
  if (!ITEM_ID_PATTERN.test(itemId) || !HANDLE_PATTERN.test(authorHandle)) return null;
```

**要点**: ここを通った値はそのまま API のパスに入る。`..` や `?` を含む値が URL 階層を書き換えるのを防ぐ。**DOM 版でもこの検証は必須**（外部データであることは変わらない）。

### メッセージの型（MESSAGE_TYPE）

```ts
// SOURCE: src/types/messages.ts:1-10
/** content script / UI -> service worker */
export type QtgRequest = { type: 'PING' } | { type: 'SCAN_NOW' };

/**
 * service worker -> 呼び出し元。
 * SCAN_ACCEPTED は「受理した」だけを意味する。スキャンの完了は待たない
 */
export type QtgResponse = { type: 'PONG'; version: string } | { type: 'SCAN_ACCEPTED' };
```

### 別コンテキストからの値の検証（TYPE_GUARD）

```ts
// SOURCE: src/content/content-script.ts:13-20
/** QtgResponse はユニオンなので、PONG だけに絞った型を用意する */
type PongResponse = Extract<QtgResponse, { type: 'PONG' }>;

function isPongResponse(value: unknown): value is PongResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PongResponse>;
  return candidate.type === 'PONG' && typeof candidate.version === 'string';
}
```

**要点**: **service worker 側も content script から来る `TREND_ITEMS` を型ガードで受けること。** 別コンテキストの値を型アサーションで信用しない。

### ログ（LOGGING_PATTERN）

```ts
// SOURCE: src/background/scanner.ts:206-216
logger.info(
  'scan finished: mode=' + mode,
  'items:',
  progress.scannedItemCount,
  'likes:',
  progress.likeRecordCount,
);
```

**要点（設計上の約束 11・13）**: 想定内の失敗は `logger.debug`。**429 は設計どおりの停止信号なので `warn` にしない。**Chrome は `console.warn` もエラー欄に集める。

### テスト（TEST_STRUCTURE）

```ts
// SOURCE: src/dom/selectors.test.ts:22-45
describe('readSnackbarMessage', () => {
  it('Snackbar が無ければ null を返し、例外を投げない', () => {
    document.body.innerHTML = '<div>no snackbar</div>';
    expect(readSnackbarMessage()).toBeNull();
  });
});
```

**要点**: `document.body.innerHTML` に骨格を組んで検証する（jsdom）。`describe` / `it` は日本語。フィクスチャは**合成値のみ**（`example-author-N` / `0123456789abcdefNNNN`）。

---

## 中核の設計: カードの特定

**Qiita のカード構造を前提にしない。** `article` や特定のクラスに依存すると、リニューアルで壊れる。代わりに **リンクから祖先を遡り、条件を満たした最初の要素をカードとみなす**。

```
リンクから親を 1 段ずつ上へ（最大 MAX_CARD_DEPTH 段）

  その要素に含まれる a[href*="/items/"] の数が LINKS_PER_CARD を超えた
    → カード境界を越えた。null を返す（この記事は捨てる）

  その要素に time[datetime] があった
    → これがカード。datetime を読む

  どちらでもない → もう 1 段上へ
```

**なぜこれが安全か**: 遡りすぎて「全カードを含むコンテナ」に到達すると、リンク数が閾値を超えて必ず `null` になる。**別の記事の投稿時刻を取り違えることが原理的に起きない。**取れなければ捨てる（設計上の約束 3 のフェイルセーフ）。

| 定数 | 値 | 根拠 |
|---|---|---|
| `LINKS_PER_CARD` | 2 | 実測。タイトル付きと無しで 30 カード = 60 リンク |
| `MAX_CARD_DEPTH` | 6 | カードの入れ子がこれ以上深いことは考えにくい。無限ループの防止も兼ねる |

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/dom/trend-reader.ts` | CREATE | 表示中ページからトレンド 30 件を読む |
| `src/dom/trend-reader.test.ts` | CREATE | 同上のテスト |
| `src/dom/selectors.ts` | UPDATE | `trendItemLink` / `trendItemTime` を追加 |
| `src/dom/selectors.test.ts` | UPDATE | 新セレクタも機械検査に通ることを確認 |
| `src/types/messages.ts` | UPDATE | `TREND_ITEMS` を追加、`SCAN_NOW` を削除 |
| `src/types/domain.ts` | UPDATE | `FeedSnapshot` 削除、`LocalState` から feed キー削除、`rateLimitedUntil` 追加 |
| `src/content/content-script.ts` | UPDATE | DOM を読んで送る |
| `src/background/service-worker.ts` | UPDATE | `TREND_ITEMS` を受ける。自動スキャンを削除 |
| `src/background/service-worker.test.ts` | UPDATE | 自動スキャンが無いことの検査に変更 |
| `src/background/scanner.ts` | UPDATE | `runScan(items)` へ。予算管理と `truncated` を削除 |
| `src/background/scanner.test.ts` | UPDATE | フィードモックを items 引数に置き換え |
| `src/api/qiita-client.ts` | UPDATE | 429 を `debug` へ。`RateLimitError` を新設 |
| `src/api/qiita-client.test.ts` | UPDATE | 429 が warn を出さないことへ変更 |
| `src/api/rate-budget.ts` | UPDATE | 予算計算を削除。`RATE_LIMIT_*` / `readRateHeaders` / `decideMode` は残す |
| `src/api/rate-budget.test.ts` | UPDATE | 削除した関数のテストを除去 |
| `src/lib/storage.ts` | UPDATE | feed キャッシュを削除、`rateLimitedUntil` を追加 |
| `src/lib/storage.test.ts` | UPDATE | 同上 |
| `src/feed/atom-parser.ts` | **DELETE** | フィード廃止 |
| `src/feed/atom-parser.test.ts` | **DELETE** | 同上 |
| `src/feed/feed-fetcher.ts` | **DELETE** | 同上 |
| `src/feed/feed-fetcher.test.ts` | **DELETE** | 同上 |

## NOT Building

- **候補一覧 UI・スライダー・適合率フィードバック** — Phase 6
- **429 のバッジ表示とポップアップ文言** — Phase 6。4b は `rateLimitedUntil` を storage に記録し `logger.info` に出すところまで
- **DOM 非表示・除外件数バッジ** — Phase 7
- **フルモードでの likes 再取得**（OQ-14）— 取得間隔が未定。4b では `itemId` があれば skip する挙動のみ
- **`QtgError` への `code` 追加**（orch-review の advisory）— 別タスク
- **判定ロジックの変更** — `src/detect/` は 1 行も触らない

---

## Step-by-Step Tasks

### Task 1: `src/dom/selectors.ts` にトレンド用セレクタを追加

- **ACTION**: `SELECTORS` に 2 つ追加し、カード探索の定数も置く
- **IMPLEMENT**:
  ```ts
  /**
   * トレンドカードの記事リンク。
   * URL のパス構造（/{handle}/items/{itemId}）は Qiita の実質的な公開 API であり、
   * CSS-in-JS のハッシュクラスと違ってリニューアルに耐える。
   *
   * ⚠️ 1 カードにつき 2 本ある（タイトル付きと無し）。実測で 30 カード = 60 リンク。
   *    href で重複排除すること。
   */
  trendItemLink: 'a[href*="/items/"]',
  /**
   * 投稿時刻。datetime 属性は HTML 標準で、秒精度の ISO 8601（UTC）が入る。
   * 表示テキスト（「2026年08月18日」）は UTC との日付ずれがあるため読まない。
   */
  trendItemTime: 'time[datetime]',
  ```
  加えてファイル末尾に:
  ```ts
  /** 1 カードに含まれる記事リンクの数。これを超えたらカード境界を越えている */
  export const LINKS_PER_CARD = 2;
  /** カードを探して祖先を遡る上限。無限ループの防止も兼ねる */
  export const MAX_CARD_DEPTH = 6;
  ```
- **MIRROR**: `SELECTOR_DEFINITION`
- **IMPORTS**: 追加不要
- **GOTCHA**: **`selectors.test.ts` が「クラスセレクタを一切使っていない」を機械検査している。** `a[href*="/items/"]` と `time[datetime]` はどちらも属性セレクタで `.` を含まないため通る。**`.style-*` はもちろん、任意のクラスセレクタを書かないこと**
- **VALIDATE**: `npx vitest run src/dom/selectors.test.ts`

### Task 2: `src/dom/trend-reader.ts`

- **ACTION**: 新規ファイル。表示中ページからトレンド 30 件を読む
- **IMPLEMENT**:
  - `const ITEM_URL_PATTERN = /^https:\/\/qiita\.com\/([^/?#]+)\/items\/([^/?#]+)/;`
  - `const ITEM_ID_PATTERN = /^[0-9a-zA-Z]+$/;` / `const HANDLE_PATTERN = /^[A-Za-z0-9_-]+$/;`
  - `function parseItemUrl(href: string): { url: string; authorHandle: string; itemId: string } | null`
    - クエリとハッシュを除いた正規化 URL を返す
    - 形式検証に落ちたら `null`
  - `function findCard(link: HTMLAnchorElement): HTMLElement | null`
    - 上の「中核の設計」のとおり祖先を遡る
  - `export function readTrendItems(root: ParentNode = document): TrendItem[]`
    - `root.querySelectorAll(SELECTORS.trendItemLink)` を走査
    - `parseItemUrl` → 失敗なら skip
    - **正規化 URL で重複排除**（`Map`）
    - `findCard` → `time[datetime]` の値を `publishedAt` に
    - どれか欠けたら skip（例外は投げない）
- **MIRROR**: `DOM_FAILSAFE`（`root: ParentNode = document`）／`URL_PARSE`（形式検証）
- **IMPORTS**:
  ```ts
  import { SELECTORS, LINKS_PER_CARD, MAX_CARD_DEPTH } from './selectors';
  import type { TrendItem } from '../types/domain';
  ```
- **GOTCHA**:
  - **`link.href` は絶対 URL に解決される**（`getAttribute('href')` は相対のことがある）。`href` プロパティを使う
  - **`datetime` 属性を読む。`textContent` は読まない** — 表示は「2026年08月18日」でも実際は `2026-08-17T17:44:41Z`（UTC）で日付がずれる
  - **形式検証を省かない。** DOM は外部データであり、ここを通った値はそのまま API のパスに入る
  - 遡りすぎ防止の `LINKS_PER_CARD` 判定を**先に**行う。`time` を先に探すと、全カードのコンテナで他人の時刻を掴む
- **VALIDATE**: `npx vitest run src/dom/trend-reader.test.ts`

### Task 3: `src/dom/trend-reader.test.ts`

- **ACTION**: Task 2 のテストを書く
- **IMPLEMENT**: 下の Testing Strategy の「trend-reader」節をすべて
- **MIRROR**: `TEST_STRUCTURE`
- **GOTCHA**: **1 カード 2 リンクの骨格を必ず再現すること。** 1 本にすると重複排除のテストが成立しない
- **VALIDATE**: 重複排除を外すと件数が 2 倍になって落ちること

### Task 4: `src/types/messages.ts`

- **ACTION**: `TREND_ITEMS` を追加、`SCAN_NOW` を削除
- **IMPLEMENT**:
  ```ts
  import type { TrendItem } from './domain';

  /** content script / UI -> service worker */
  export type QtgRequest = { type: 'PING' } | { type: 'TREND_ITEMS'; items: TrendItem[] };
  ```
  `QtgResponse` の `SCAN_ACCEPTED` はそのまま使う
- **GOTCHA**: **`SCAN_NOW` を消すと `service-worker.test.ts` の 1 件が落ちる。** それが正しい（起動契機が変わったため）。Task 8 で書き換える
- **VALIDATE**: `npm run typecheck`

### Task 5: `src/api/rate-budget.ts` の簡素化

- **ACTION**: 予算計算を削除する
- **IMPLEMENT**:
  - **削除**: `RATE_SAFETY_MARGIN` / `availableRequests()` / `fallbackLimitFor()`
  - **残す**: `RATE_LIMIT_ANON` / `RATE_LIMIT_AUTH`、`RateState`、`readRateHeaders()`、`decideMode()`
  - ファイル冒頭のコメントに「予測的な予算管理は行わない。429 まで走る」理由を書く
- **GOTCHA**: **`token-form.ts:23` が `RATE_LIMIT_ANON` / `RATE_LIMIT_AUTH` を import している。** これらを消すと options ページが壊れる
- **VALIDATE**: `npm run typecheck`

### Task 6: `src/api/qiita-client.ts` の 429 対応

- **ACTION**: 429 を `debug` に下げ、`Rate-Reset` を呼び出し側へ渡せるようにする
- **IMPLEMENT**:
  - `logger.warn('api rate limit exceeded:', path)` → `logger.debug(...)`
  - コメントに理由: 「429 は改訂 6 で設計どおりの停止信号になった。warn はエラー欄に載る」
  - 専用のエラー型を新設する:
    ```ts
    /** 429 に達したことと、いつ再開できるかを表す */
    export class RateLimitError extends QtgError {
      constructor(readonly resetAt: number | null) {
        super('api rate limit exceeded');
        this.name = 'RateLimitError';
      }
    }
    ```
  - 429 の分岐で `throw new RateLimitError(readRateHeaders(response.headers)?.resetAt ?? null);`
- **MIRROR**: `src/lib/errors.ts` の `QtgError`（`name` を設定する書き方）
- **GOTCHA**: **`scanner` の catch が `logger.debug` であることを確認する**（改訂 5 で修正済み）。ここを直しても scanner が warn なら同じログが戻ってくる
- **VALIDATE**: `npx vitest run src/api`

### Task 7: `src/background/scanner.ts` の作り直し

- **ACTION**: フィード取得と予算管理を外し、items を引数で受ける
- **IMPLEMENT**:
  - `export async function runScan(items: TrendItem[]): Promise<ScanResult | null>`
  - **削除**: `fetchFeedIfChanged` の import と呼び出し、`ScanProgress.budget`、`nextBudget()`、`truncated` の伝播、`storage.saveFeedCache` の呼び出し
  - **新設**: 既知の記事を除外する
    ```ts
    const stored = await storage.getLikeIndex();
    const known = collectKnownItemIds(stored);
    const fresh = items.filter((item) => !known.has(item.itemId));
    logger.info('trend items:', items.length, 'new:', fresh.length);
    ```
  - **429 で停止**: ループで `RateLimitError` を捕まえたら break し、`storage.saveRateLimit(error.resetAt)` を呼ぶ
  - `ScanResult` から `truncated` を落とし、`newItemCount` を足す
- **MIRROR**: `LOGGING_PATTERN`
- **IMPORTS**: `fetchFeedIfChanged` を削除、`RateLimitError` を追加
- **GOTCHA**:
  - **個々の記事の失敗は `logger.debug` のまま**（約束 11）。429 での停止も `debug` ＋ `info` の集計行
  - **全滅時の `warn` は残す**（`scan produced no data`）。ただし**429 で止まった場合は全滅ではない**ので判定に含めない
  - 検出（`detectCandidates`）は**新着ゼロでも回す**。前回の蓄積で候補が出る
- **VALIDATE**: `npx vitest run src/background`

### Task 8: `src/background/service-worker.ts`

- **ACTION**: `TREND_ITEMS` を受け、自動スキャンを削除する
- **IMPLEMENT**:
  - `onInstalled` は `logger.info('installed:')` のみ残し、`safeScan` を呼ばない
  - `onStartup` のリスナーごと削除
  - `onMessage` で `TREND_ITEMS` を受け、**型ガードで検証**してから `safeScan(items)`
  - 冒頭コメントを「定期実行も自動スキャンも持たない。起動契機はトレンドページを開いたときだけ」に更新
- **MIRROR**: `TYPE_GUARD`
- **GOTCHA**:
  - **`items` の中身を検証すること。** 別コンテキストから来る配列であり、`itemId` はそのまま API のパスに入る。**`trend-reader` が検証済みでも、メッセージ境界を越えたら再検証**する
  - `sendResponse` は同期で返し、`return false` を維持する
- **VALIDATE**: `npx vitest run src/background/service-worker.test.ts`

### Task 9: `src/content/content-script.ts`

- **ACTION**: DOM を読んで送る
- **IMPLEMENT**:
  ```ts
  async function sendTrendItems(): Promise<void> {
    const items = readTrendItems();
    if (items.length === 0) {
      // トレンドページ以外（記事ページなど）では 0 件が正常
      logger.debug('no trend items on this page');
      return;
    }
    logger.info('trend items read:', items.length);
    try {
      const request: QtgRequest = { type: 'TREND_ITEMS', items };
      await chrome.runtime.sendMessage(request);
    } catch (error) {
      logger.error('failed to send trend items:', error);
    }
  }
  ```
- **GOTCHA**:
  - **0 件は正常。** content script は `https://qiita.com/*` 全体に注入されるため記事ページでも動く。**`warn` を出さないこと**
  - `document_idle` でも要素が揃っていない可能性がある。**まず素直に読み、実機で 0 件なら MutationObserver を検討する**（先回りして複雑にしない）
- **VALIDATE**: `npm run build` ＋ 実機

### Task 10: `src/lib/storage.ts` と `src/types/domain.ts`

- **ACTION**: feed キャッシュを削除し、`rateLimitedUntil` を追加
- **IMPLEMENT**:
  - `storage.ts`: `getFeedCache` / `saveFeedCache` を削除。`getRateLimitedUntil(): Promise<number | null>` と `saveRateLimit(resetAt: number | null)` を追加
  - `domain.ts`: `FeedSnapshot` を削除。`LocalState` から `lastFeedUpdated` / `feedETag` を削除し `rateLimitedUntil?: number` を追加。`ScanResult` の `truncated` を落とし `newItemCount: number` を追加
- **MIRROR**: `storage.ts` の既存フェイルセーフ（壊れた値は既定値へ）
- **GOTCHA**: `rateLimitedUntil` は **epoch 秒**（`Rate-Reset` の単位）。ミリ秒と混同しない。`rate-budget.ts` の `RateState.resetAt` に「Unix 秒。ミリ秒ではない」とある
- **VALIDATE**: `npx vitest run src/lib`

### Task 11: `src/feed/` の削除

- **ACTION**: 4 ファイルを削除する
- **IMPLEMENT**:
  ```bash
  rm src/feed/atom-parser.ts src/feed/atom-parser.test.ts \
     src/feed/feed-fetcher.ts src/feed/feed-fetcher.test.ts
  rmdir src/feed
  ```
- **GOTCHA**: **`atom-parser.ts` の URL 正規表現を Task 2 で移植済みか先に確認する。** 消してから「あれが要る」となると履歴を掘ることになる
- **VALIDATE**: `npm run typecheck` — 参照が残っていればここで落ちる

### Task 12: 全体検証と実機確認

- **ACTION**: 検証コマンドをすべて流し、実機で確認する
- **GOTCHA**: **ビルド成功は「正しく動く」を意味しない。** `dist/` の配線を必ず確認する
- **VALIDATE**: Manual Validation のチェックリスト

---

## Testing Strategy

### trend-reader

フィクスチャは合成値。**1 カード 2 リンク**の骨格を再現する。

```ts
function card(n: number, opts: { time?: string | null } = {}): string {
  const handle = `example-author-${String(n)}`;
  const itemId = `0123456789abcdef${String(n).padStart(4, '0')}`;
  const url = `https://qiita.com/${handle}/items/${itemId}`;
  const time =
    opts.time === null
      ? ''
      : `<time datetime="${opts.time ?? '2026-08-18T10:00:00Z'}">2026年08月18日</time>`;
  return `<div><a href="${url}"></a>${time}<a href="${url}">タイトル ${String(n)}</a></div>`;
}
```

| Test | Input | Expected | Edge? |
|---|---|---|---|
| カード 30 枚から 30 件を返す | 30 カード（60 リンク） | 30 件 | |
| **同じ記事の 2 本のリンクを 1 件に畳む** | 1 カード（2 リンク） | **1 件** | ✅ |
| URL から handle と itemId を取る | 1 カード | 期待値と一致 | |
| `datetime` を投稿時刻にする | `2026-08-17T17:44:41Z` | そのまま | |
| **表示テキストではなく datetime を読む** | text「2026年08月18日」/ datetime `...17T17:44:41Z` | **datetime 側** | ✅ |
| `<time>` が無いカードは捨てる | `time: null` | そのカードだけ落ちる | ✅ |
| `datetime` が空のカードは捨てる | `datetime=""` | 落ちる | ✅ |
| handle に `..` を含む URL は捨てる | `https://qiita.com/../items/xxx` | 落ちる | ✅ |
| itemId に想定外の文字 | `..%2Fadmin` | 落ちる | ✅ |
| クエリ付き URL でも itemId を取れる | `?utm_source=x` | クエリを除いた URL | ✅ |
| トレンド以外のページ | リンクなし | `[]`、例外なし | ✅ |
| 空の DOM | `''` | `[]` | ✅ |
| **カード外の `<time>` を取り違えない** | カードの外側に別の `<time>` | そのカードは落ちる | ✅ |
| 祖先を遡りすぎない | 全カードを包む親に `<time>` | 個々のカードは落ちる | ✅ |

### scanner（変更分）

| Test | Input | Expected | Edge? |
|---|---|---|---|
| 引数の items をスキャンする | 2 件 | `fetchLikes` が 2 回 | |
| **既にインデックスにある記事は叩かない** | 2 件（うち 1 件は既知） | `fetchLikes` が 1 回 | ✅ |
| 全件既知なら API を 1 度も叩かない | 全件既知 | 0 回。検出は走る | ✅ |
| 空配列でも例外を投げない | `[]` | 例外なし | ✅ |
| **429 で停止し `rateLimitedUntil` を保存** | 2 件目で `RateLimitError` | 1 件目だけ保存、reset が記録される | ✅ |
| **429 は全滅の warn を出さない** | 1 件目で 429 | `logger.warn` が呼ばれない | ✅ |
| 429 で止まった残りは次回拾える | 2 回目の呼び出し | 未取得分だけ叩く | ✅ |

### service-worker（変更分）

| Test | Input | Expected | Edge? |
|---|---|---|---|
| **`TREND_ITEMS` を受けるとスキャンする** | 有効な items | `runScan` が呼ばれる | |
| **不正な items は拒否する** | `items: 'not-an-array'` | `runScan` が呼ばれない | ✅ |
| 要素の形が違う items は拒否 | `[{ foo: 1 }]` | 呼ばれない | ✅ |
| **`onInstalled` でスキャンしない** | 発火 | `runScan` が呼ばれない | ✅ |
| **`onStartup` リスナーを登録しない** | 起動 | `addListener` が呼ばれない | ✅ |
| `alarms` を登録しない（既存） | ライフサイクル一巡 | 呼ばれない | ✅ |
| `PING` は従来どおり | — | `PONG` | |

### Edge Cases Checklist

- [ ] トレンド以外のページで content script が動く（0 件で静かに終わる）
- [ ] 同じページを 2 回開く（2 回目は 0 req）
- [ ] `<time>` が 1 つも無いページ
- [ ] リンクが 0 本のページ
- [ ] 429 が 1 件目で返る
- [ ] `Rate-Reset` ヘッダーが欠けた 429
- [ ] service worker が寝ている状態でメッセージが来る
- [ ] 別コンテキストから壊れた `TREND_ITEMS` が来る

---

## Validation Commands

### Static Analysis

```bash
npm run typecheck
```

EXPECT: エラー 0。**`src/feed/` を消した参照漏れはここで出る**

### Lint

```bash
npm run lint
```

EXPECT: 0 件

### Unit Tests

```bash
npx vitest run src/dom src/background
```

EXPECT: 全通過

### Full Test Suite

```bash
npm run test
```

EXPECT: 全通過。**`src/feed/` の 2 ファイル分（約 40 件）が減る**

### Coverage

```bash
npm run test -- --coverage
```

EXPECT: Statements 80% 以上。`src/dom/trend-reader.ts` は 95% 以上

### Build

```bash
npm run build
```

EXPECT: 成功

### dist の配線検証（CLAUDE.md 必須）

```bash
cat dist/service-worker-loader.js && grep -o 'getURL("[^"]*")' dist/assets/*loader*.js
```

EXPECT: SW と CS のローダーが**別々の正しいチャンク**を指す

### Manual Validation（実機）

- [ ] `dist/` を未パック拡張として読み込み直す
- [ ] `https://qiita.com/trend` を開く
- [ ] content script のログに `trend items read: 30` が出る（**30 でなければ下の診断へ**）
- [ ] service worker のログに `trend items: 30 new: 30` が出る
- [ ] `index merged:` と `detected N candidates` が出る
- [ ] **同じページをリロードし、`new: 0` になる**（API を叩かない）
- [ ] `https://qiita.com/` でも同様に動く
- [ ] 記事ページを開いても**エラー欄に何も出ない**（0 件は正常）
- [ ] **エラー欄が空のまま**

#### 30 件にならなかったときの診断

`https://qiita.com/trend` の DevTools で実行し、カード構造を確認する。

```javascript
const a = document.querySelector('a[href*="/items/"]');
let el = a, path = [];
while (el && el !== document.body && path.length < 8) {
  path.push({
    tag: el.tagName,
    hasTime: !!el.querySelector('time[datetime]'),
    links: el.querySelectorAll('a[href*="/items/"]').length,
  });
  el = el.parentElement;
}
JSON.stringify({ total: document.querySelectorAll('a[href*="/items/"]').length, path }, null, 1)
```

`hasTime: true` になる最初の階層で `links` が 3 以上なら `LINKS_PER_CARD` を上げる。`hasTime` がどこにも無ければ `<time>` の位置が想定と違う。

---

## Acceptance Criteria

- [ ] Task 1〜12 完了
- [ ] 検証コマンドがすべて通る
- [ ] `src/feed/` が存在しない
- [ ] 型エラー 0、lint エラー 0
- [ ] **`src/detect/` を 1 行も変更していない**
- [ ] `selectors.test.ts` の機械検査を新セレクタが通る
- [ ] `logger.warn` / `logger.error` を新たに増やしていない（429 は `debug`）
- [ ] 実アカウント名・実 item_id がテストフィクスチャに無い

## Completion Checklist

- [ ] `trend-reader` が `root: ParentNode = document` を受け、テストで任意の DOM を渡せる
- [ ] DOM 取得の失敗が例外にならず、記事単位で捨てられる
- [ ] メッセージ境界で `items` を再検証している
- [ ] カード探索が「遡りすぎ」を構造的に防いでいる
- [ ] 閾値がすべて名前付き定数
- [ ] **各テストについて、直した箇所を戻すと落ちることを確認した**
- [ ] PRD の Phase 4b を `complete` に更新した

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **トレンドページが遅延描画され、`document_idle` で 0 件になる** | **中** | **高** | まず素直に読む。実機で 0 件なら MutationObserver を足す。**先回りして複雑にしない** |
| カード探索が別カードの `<time>` を掴む | 低 | **高** | `LINKS_PER_CARD` 超過で `null` を返す設計により原理的に防ぐ。専用テストあり |
| `<time>` の位置がカード外 | 低 | 高 | 診断スニペットを Manual Validation に用意。`MAX_CARD_DEPTH` の調整で対応 |
| `src/feed/` 削除で参照漏れ | 低 | 低 | `npm run typecheck` が確実に検出する |
| `SCAN_NOW` 廃止で popup の手動実行が消える | 中 | 低 | 手動スキャン＝トレンドページを開く／リロード、に変わる。Phase 6 で必要なら content script 経由で復活 |
| **429 が `warn` のまま残る経路** | 中 | 中 | **改訂 5 で踏んだ失敗の再来。**`qiita-client` と `scanner` の**両方**を確認し、テストで固定する |

## Notes

### この計画が触らないもの

`src/detect/` は 1 行も変更しない。**インデックスを受け取るだけで出所を問わない設計**にしてあることが、この作り直しのコストを検出層に波及させていない。設計判断が後から効いた実例として記録しておく。

### 記事化の素材

- **公式が出す 2 つの入口が別物だった。** 実装が全部通り、実機でも動き、5 件検出できてもなお、見ている対象が違っていた。テストでもビルドでも実機ログでも検出できない種類の誤り
- **禁止を迂回するのではなく、前提ごと消した。** `robots.txt` を根拠に「スクレイピングは許される」と論じる道もあったが、表示中の DOM を読めばリクエストが増えず、解釈そのものが不要になる
- **予測をやめると設計が減った。** レート枠を予測する方式は、余白の見積もりという別の不確実性と、打ち切り状態の全レイヤー伝播を招いていた。「429 まで走る」に変えるだけで 5 つの概念が消える

### 実装順序の推奨

`selectors` → `trend-reader` → `messages` → `rate-budget` → `qiita-client` → `scanner` → `service-worker` → `content-script` → `storage`/`domain` → `feed` 削除。

**削除は最後。** 先に消すと型エラーが大量に出て、どれが本質的な作業か見分けがつかなくなる。
