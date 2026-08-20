# Implementation Report: データ取得層（DOM 版）— Phase 4b

## Summary

Atom フィードを廃止し、**ユーザーが開いているトレンドページの DOM** からトレンド記事を読む層へ全面移行した。追加リクエストはゼロ。あわせてレート枠の予測的な予算管理をやめ、**429 が返るまで走って返ったら止める**方式へ変えた。

`src/detect/` は 1 行も変更していない。インデックスを受け取るだけで出所を問わない設計にしてあったため、取得層の作り直しが検出層に波及しなかった。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large（想定どおり） |
| Confidence | 7/10 | **妥当**。設計上の迷いは無かったが、遅延描画の不確実性は解消していない（実機未確認） |
| Files Changed | 新規 2 / 変更 15 / 削除 4 | 新規 3 / 変更 15 / 削除 4 |
| テスト | — | 212 件（211 → 212。`src/feed/` の 26 件が消え、新規 27 件が入った） |

新規が 1 多いのは `src/lib/errors.ts` の `RateLimitError`（下記 Deviation 1）。

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | `selectors.ts` にトレンド用セレクタ | 完了 | 機械検査（クラスセレクタ禁止）を通過 |
| 2 | `dom/trend-reader.ts` | 完了 | |
| 3 | `dom/trend-reader.test.ts` | 完了 | 17 件 |
| 4 | `types/messages.ts` | 完了 | `SCAN_NOW` → `TREND_ITEMS` |
| 5 | `api/rate-budget.ts` の簡素化 | 完了 | 3 つの export を削除 |
| 6 | `api/qiita-client.ts` の 429 対応 | 完了 | **逸脱あり** — 下記 1 |
| 7 | `background/scanner.ts` の作り直し | 完了 | **逸脱あり** — 下記 2・3 |
| 8 | `background/service-worker.ts` | 完了 | 自動スキャンを全廃 |
| 9 | `content/content-script.ts` | 完了 | |
| 10 | `lib/storage.ts` / `types/domain.ts` | 完了 | |
| 11 | `src/feed/` の削除 | 完了 | 4 ファイル |
| 12 | 全体検証 | **部分的** | 静的検証はすべて通過。**実機確認は未実施**（下記） |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis (tsc) | Pass | エラー 0 |
| Lint (eslint) | Pass | 0 件 |
| Unit Tests | Pass | 212 件 |
| Build | Pass | `✓ built in 93ms` |
| dist 配線 | Pass | SW → `service-worker.ts-BBZr93sW.js` / CS → `content-script.ts-DSUjx0nc.js` の別チャンク |
| Coverage | Pass | Statements 97.07%。`trend-reader.ts` は **97.22%**（目標 95%） |
| **Manual（実機）** | **Pass** | 2026-08-20 実施。下記「実機の結果」 |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `src/dom/trend-reader.ts` | CREATED | +105 |
| `src/dom/trend-reader.test.ts` | CREATED | +178 |
| `src/lib/errors.ts` | UPDATED | +25 |
| `src/dom/selectors.ts` | UPDATED | +25 / -2 |
| `src/dom/selectors.test.ts` | UPDATED | +3 / -3 |
| `src/types/messages.ts` | UPDATED | +9 / -2 |
| `src/types/domain.ts` | UPDATED | +13 / -13 |
| `src/content/content-script.ts` | UPDATED | +24 |
| `src/background/service-worker.ts` | UPDATED | +52 / -30 |
| `src/background/service-worker.test.ts` | UPDATED | +100 / -31 |
| `src/background/scanner.ts` | UPDATED | +130 / -85 |
| `src/background/scanner.test.ts` | UPDATED | +160 / -107 |
| `src/api/qiita-client.ts` | UPDATED | +8 / -3 |
| `src/api/qiita-client.test.ts` | UPDATED | +30 / -8 |
| `src/api/rate-budget.ts` | UPDATED | +12 / -25 |
| `src/api/rate-budget.test.ts` | UPDATED | +10 / -40 |
| `src/lib/storage.ts` | UPDATED | +25 / -23 |
| `src/lib/storage.test.ts` | UPDATED | +32 / -30 |
| `src/feed/atom-parser.ts` | **DELETED** | -79 |
| `src/feed/atom-parser.test.ts` | **DELETED** | -142 |
| `src/feed/feed-fetcher.ts` | **DELETED** | -84 |
| `src/feed/feed-fetcher.test.ts` | **DELETED** | -139 |

## Deviations from Plan

### 1. `RateLimitError` を `qiita-client.ts` ではなく `lib/errors.ts` に置いた

- **WHAT**: 計画の Task 6 は「`qiita-client.ts` に専用のエラー型を新設する」だった。実際は `src/lib/errors.ts` に `QtgError` のサブクラスとして置いた
- **WHY**: `scanner.test.ts` は `vi.mock('../api/qiita-client', () => ({ fetchLikes: vi.fn(), fetchUserItems: vi.fn() }))` でモジュールごとモックする。エラー型がクライアント側にあると、モックのファクトリが返さない限り import が `undefined` になり、`error instanceof RateLimitError` が**実行時に TypeError で落ちる**。型エラーにはならないので、テストを書くまで気づかない類の壊れ方になる。例外型は例外の置き場に集めた

### 2. `runScan` は空配列で `null` を返す

- **WHAT**: 計画は戻り値を `ScanResult | null` としつつ、`null` になる条件を書いていなかった（旧実装では「フィード不変」が唯一の `null`）
- **WHY**: content script は `https://qiita.com/*` 全体に注入されるため、記事ページでも `runScan` が呼ばれうる。0 件は正常なので `logger.debug` を 1 行だけ出して `null` を返す。`ScanResult` を作ってスキャン結果として保存すると、「0 件をスキャンした」という無意味な記録が `lastScanResult` を上書きする

### 3. `persistScan` の引数をオブジェクトにした

- **WHAT**: 位置引数 6 つ（mode, progress, startedAt, stored, fresh, newItemCount）を `PersistInput` インターフェースにまとめた
- **WHY**: `LikeIndex` 型の引数が `stored` と `fresh` の 2 つ並び、位置を取り違えても型エラーにならない。取り違えると**蓄積を今回分で上書きする**という、テストでも気づきにくい壊れ方をする

### 4. `seen` を蓄積済み itemId で初期化した

- **WHAT**: 計画は新着記事のフィルタ（`known`）だけを求めていた。実装ではフルモードの過去記事巡回で使う `seen` も同じ集合で初期化した
- **WHY**: 初期化しないと、著者の過去記事のうち既にインデックスにあるものを毎回取り直す。フルモードは 1 スキャン約 120 req なので、ここの重複は枠に直接効く

### 5. `Rate-Reset` が無い 429 のフォールバックを実装した

- **WHAT**: 計画は `saveRateLimit(error.resetAt)` としか書いておらず、`resetAt` が `null` のときの扱いが未定義だった
- **WHY**: `null` をそのまま保存すると「止まっている」事実ごと消える（`saveRateLimit(null)` はキーを削除する仕様のため）。ユーザーの指示「エラーが発生した時点から 1 時間後に試すように促す」に従い、`RATE_WINDOW_SECONDS = 3600` を足した時刻を記録する。枠は 1 時間単位で回復するので、この既定値は実際の回復より遅くなることはあっても早くはならない

### 6. `sendTrendItems` の catch を `logger.error` ではなく `logger.debug` にした

- **WHAT**: 計画の Task 9 のコードは `logger.error('failed to send trend items:', error)` だった。実装では `logger.debug` に下げた
- **WHY**: 同じ content script の `ping()` が、service worker に届かない事実を既に `error` で 1 行出している。ここで 2 行目を出すと、**拡張をリロードしたときに開いていた qiita.com のタブ全部で 2 行ずつ**エラー欄に積まれる。拡張のリロードは古い content script を孤児にするので `sendMessage` は必ず落ちるが、それはユーザーの操作どおりの結果であって不具合ではない。**計画の Manual Validation は「`dist/` を読み込み直す」と「エラー欄が空のまま」を両方求めており、そのままでは受け入れ基準が自分自身と矛盾していた**。届かなかったトレンドは次にページを開けば拾える

## Issues Encountered

### `perl -0777` の巨大な正規表現が `storage.ts` を破損させた

複数行にわたる置換パターンが部分的にマッチし、置換後のテキストと元の残骸が連結された。**型チェックは通らないので黙って壊れることはなかった**が、原因の切り分けに時間を使った。以降は `node` で**完全一致の文字列置換**（`String.replace` に文字列を渡す）に切り替えた。正規表現は「どこまでマッチしたか」が見えないため、機械的な編集には向かない。

### Bash の heredoc が 140 行付近で切り捨てられる（既知）

`scanner.test.ts`（361 行）を 1 回の heredoc で書こうとして `unexpected EOF` で失敗した。**ファイルは書き込まれず旧版のまま残った**ため被害は無し。6 分割して追記した。

### 変異テストのハーネスが全件「捕まらない」と報告した

`npx vitest run <file> --reporter=basic` の `basic` が vitest 4 に存在せず、`execSync` が即座に throw していた。出力が空 → 失敗件数 0 → **13 件すべて「NOT CAUGHT」**という、いかにも本物らしい結果が出た。全件が同じ結論になったこと自体が異常の兆候だった。

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `src/dom/trend-reader.test.ts` | 17 | 重複排除、datetime の優先、形式検証、カード特定、深さ制限 |
| `src/background/scanner.test.ts` | 26（+2） | 既知記事の除外、429 の停止と記録、ログ水準、蓄積と検出 |
| `src/background/service-worker.test.ts` | 14（+7） | 起動契機、メッセージ境界の再検証 |
| `src/api/qiita-client.test.ts` | 26（+1） | `RateLimitError` と `resetAt`、429 が warn を出さないこと |
| `src/lib/storage.test.ts` | 18（+1） | `rateLimitedUntil` の往復・削除・壊れた値 |
| `src/api/rate-budget.test.ts` | 8（-4） | 削除した予算計算のテストを除去 |

## テストがバグを捕まえることの確認

実装を 14 通りに壊し、狙ったテストが落ちるかを機械的に確かめた。

| 戻した内容 | 落ちたテスト |
|---|---|
| カード境界の判定を `time` より後にする | **3 件** |
| `datetime` ではなく `textContent` を読む | 4 件 |
| URL の形式検証を外す | 2 件 |
| `MAX_CARD_DEPTH` を 6 → 60 にする | 1 件 |
| Map のキーをリンクごとに一意にする | 5 件 |
| 既知記事の除外をやめる | 3 件 |
| 429 を普通の失敗として扱う（停止しない） | **5 件** |
| 429 でも全滅の warn を出す | 1 件 |
| 429 の記録を消さない（回復しても止まったまま） | 1 件 |
| `qiita-client` の 429 を warn に戻す | 1 件 |
| メッセージ境界の再検証を外す | **6 件** |
| インストール時に自動スキャンを戻す | 1 件 |
| ブラウザ起動のリスナーを戻す | 1 件 |
| ~~`byUrl.has()` の早期 continue を外す~~ | **0 件 — 捕まらなかった** |

### 捕まらなかった 1 件が示したこと

`if (byUrl.has(parsed.url)) continue;` を丸ごと消しても、**テストは 1 件も落ちない**。

同じ URL に対して `byUrl.set()` が 2 回走るだけで、Map のキーが同じなので結果は変わらないからである。つまり**重複排除の実体は Map のキー（正規化 URL）であり、この行は `findCard` の祖先探索を 2 回やらないための省略にすぎない**。

コードのコメントは「1 カードに 2 本あるリンクを 1 件に畳む」と書いており、**この行が畳み込みの仕組みであるかのように読めた**。変異テストが捕まえたのはバグではなくコメントの誤りで、実際に直したのはコメントの方である。畳み込みの本体（Map のキー）を壊す変異は 5 件を落とすことも別途確認した。

**「テストが落ちないから消してよい」ではない。**この行を消すと 30 カードで 30 回の無駄な祖先探索が走る。落ちない理由を確かめるところまでやらないと、消してよいのか残すべきなのかが分からない。

## 実機の結果（2026-08-20）

### 初回スキャン（新規インストール直後・ライトモード）

```
[QTG] service worker booted 0.1.0
[QTG] installed: install version: 0.1.0
[QTG] trend items: 25 new: 25 mode=light
[QTG] index merged: accounts: 308 records: 363 purged: 0
[QTG] detected 2 candidates (N>=5 M>=2 within 3d)
[QTG] scan finished: mode=light items: 25 likes: 363 rate-remaining: 35
```

### リロード後

```
[QTG] trend items: 25 new: 0 mode=light
[QTG] index merged: accounts: 308 records: 363 purged: 0
[QTG] detected 2 candidates (N>=5 M>=2 within 3d)
[QTG] scan finished: mode=light items: 0 likes: 0 rate-remaining: unknown
```

| 検証項目 | 結果 |
|---|---|
| DOM からトレンドを読む | ✅ 25 件（画面に出ている全件） |
| service worker へ渡る | ✅ `trend items: 25` |
| 蓄積と検出が走る | ✅ `accounts: 308` / 候補 2 件 |
| **リロードで API を叩かない** | ✅ `new: 0` |
| **1 記事 = 1 リクエスト** | ✅ `rate-remaining: 35` = 60 − 25 |
| ログ水準 | ✅ 提示されたログに warn / error は 1 行も無い（`chrome://extensions` のエラー欄そのものは未報告） |

### 最大リスクは空振りした

計画のリスク表で「中／高」としていた **`document_idle` の時点でトレンドカードが描画されていない**は起きなかった。**MutationObserver は入れていない。**先回りして入れていたら、必要だったのかどうかが永久に分からなくなっていた。

### 25 件は取りこぼしではない

30 件でなく 25 件だったのは、**ミュート済みのアカウントの記事がトレンドページに出ないため**である。PRD の 2026-08-18 の実測（ミュート 2 名 ＋ ブロック 1 名 = 対象記事 5 本で 30 → 25）と**完全に一致**する。

これは Atom フィード版には無かった性質である。フィードは誰が見ても 30 件だが、**トレンドページは個人化されている**。DOM に切り替えたことで、拡張の入力がユーザー自身の操作履歴に依存するようになった。

| 影響 | 向き |
|---|---|
| 判定済みの著者が入力から落ちる | **良い** — 枠を無駄にしない |
| ミュート済み著者の新しい記事は二度と入らない | 中立 — 既に判定済み |
| **誤検知でミュートしたアカウントは視界から消え、再評価できない** | **悪い** — 適合率フィードバックは**ミュート前**にしか取れない |

3 つ目は Phase 6 の UI 順序に直接効く。PRD に **OQ-16** として記録した。

### 実機ログが 1 つ欠陥を見つけた

`trend items: 25`（入力件数）の直後に `scan finished: items: 0`（取得できた件数）が出ていた。**同じ `items:` が 2 つの意味で使われており**、全件既知のときの `items: 0` が「何も取れなかった」と読める。`fetched:` に改めた。

**テストは 212 件すべて通っていた。**ログの読みやすさは型でもテストでも守れない。
## 検証ループで見つかった欠陥（実装後）

### フルモードではリロードのたびに著者数ぶん消費していた

```ts
// 修正前
const handles = [...new Set(items.map((item) => item.authorHandle))];
```

`fetchUserItems` は `seen` を見る **前** に呼ばれる。著者を `items`（画面の全件）から取ると、**全件既知でも著者数ぶんのリクエストが飛ぶ**。トレンド 1 ページで最大 30 req。

「リロードでは API を 1 度も叩かない」という設計目標は、**ライトモードでしか成立していなかった**。

```ts
// 修正後 — 新着記事の著者だけを辿る
const handles = [...new Set(newItems.map((item) => item.authorHandle))];
```

既知の著者を再訪する頻度は **OQ-14（再取得の間隔）** の領域で、Phase 4b の射程外。落ちるテストを先に書いて確認済み（`likesMock` が 1 回呼ばれて失敗 → 修正後 0 回）。

**これは実機ログでは絶対に見つからなかった。**検証したのはトークン未設定のライトモードで、その経路では正しく 0 リクエストだったため。

## マルチエージェントレビューで見つかった欠陥

3 次元（品質・TypeScript・セキュリティ）で並列レビューし、CRITICAL/HIGH は 1 件ずつ反証を試みた。**HIGH 2 件（実体は同一）・MEDIUM 1 件・LOW 2 件。**

### HIGH: スキャンが重なると蓄積が消える

`runScan` が開始時に読んだ `stored` を、25 本前後の直列リクエスト（数秒）のあいだ持ち回り、最後の merge に使っていた。**この差分より前は `getLikeIndex()` が merge の直前にあり、窓は 1 マイクロタスクだった。**`collectKnownItemIds` のために読みを先頭へ移したとき、保存側の読み直しを残さなかった。

しかも Phase 4b で**契機が変わった**。以前は `onInstalled` / `onStartup` / 手動で、重なることは考えにくかった。いまは **qiita.com のページを開くたび**で、service worker は待ち行列もロックも持たない fire-and-forget。**2 タブ開くだけで重なる。**

| 起きること | 影響 |
|---|---|
| 2 本とも同じ 25 件を叩く | **60 req/h を一気に使い切る** |
| 後から終わった側が merge を上書き | 先に終わった側の収穫が消える |
| 429 で止まった側が空の fresh で保存 | **もう片方の収穫が丸ごと消える** |
| 429 なしで終わった側が `saveRateLimit(null)` | 実際は枠切れなのにバッジが「正常」を出す |

修正は 2 つ。**保存の直前に読み直す**（差分前の性質を復元）と、**同時実行のガード**（`options-page.ts` の `busy` と同じ形）。ガードは重なりそのものを防ぎ、読み直しは重なった場合の被害を防ぐ。

### MEDIUM: トレンドページ以外でも読んでいた

content script は `https://qiita.com/*` 全体に注入される。`readTrendItems` はページを問わず `a[href*="/items/"]` と近くの `time[datetime]` を探すため、**プロフィールページ（その人の記事一覧に記事リンクと `<time>` が揃っている）でも記事を拾う**。トレンドでない記事に枠を使い、インデックスの中身も「トレンドの共起」ではなくなる。

`isTrendPage(pathname)` で `/` と `/trend` に絞った。

**これは私の実機検証が素通りさせた穴である。**チェックリストに「記事ページを開いてもエラー欄に何も出ない」を書いておきながら、実施しなかった。エラーが出ないことと、やるべきでないことをやらないことは別物だった。

### LOW: `url` を型チェックしかしていなかった

メッセージ境界の `isTrendItem` は `itemId` / `authorHandle` に正規表現をかけていたが、`url` は `typeof` だけだった。`url` は API のパスには入らないが、**Phase 6 が候補一覧でリンクとして描画する**。`javascript:` を持ち込める。

検証済みの 2 つから組み立て直して一致を見る形にした。新しい正規表現を増やさずに閉じられる。

### 見送った LOW: 3 箇所に散った「安全なパスセグメント」の正規表現

`trend-reader`・`service-worker`・`qiita-client` が別々に持っている。DRY では共通化すべきだが、**これは意図的な多層防御であり、1 つの定数に寄せると 3 層が同時に壊れる**。`trend-reader` の itemId だけ `[0-9a-zA-Z]`（`_-` 無し）と厳しいのも実測に基づく意図的な差。共通化しない。

### 5 つの変異すべてがテストに捕まることを確認

| 戻した内容 | 落ちたテスト |
|---|---|
| 同時実行のガードを外す | 1 件 |
| 保存直前の読み直しをやめる | 4 件 |
| `isTrendPage` を常に true にする | 3 件 |
| 末尾スラッシュの正規化を外す | 1 件 |
| `url` の一致チェックを typeof に戻す | 3 件 |

### テストが素通りしていたことに、書いた直後に気づいた

「スキャン中に保存された蓄積を上書きで消さない」は、最初の版では**バグがあるのに通っていた**。storage モックの `set` は Map を**同期的に**書くため、外部書き込みがスキャンの `getLikeIndex()` **より前**に着地していた。「読んだあとに他者が書いた」状況を再現できていなかった。

fetch に到達したことを知らせる `entered` を足して初めて RED になった。**RED を確認する手順が無ければ、この 1 件は永久に嘘の緑を返し続けていた。**

## 記事化の素材

- **予測をやめると設計が減った。** レート枠を予測する方式を捨てたことで `RATE_SAFETY_MARGIN` / `availableRequests` / `fallbackLimitFor` / `ScanProgress.budget` / `truncated` の伝播という **5 つの概念が消えた**。代わりに増えたのは `RateLimitError` 1 つ。不確実性を予測で埋めようとすると、予測の精度という**別の不確実性**が生まれる
- **「テストが落ちる」ことを確かめないと、テストが何を守っているのか分からない。** 14 通り壊して 13 通りは捕まえた。捕まらなかった 1 件は、**コードのコメントが仕組みを誤って説明していた**ことを示していた。バグではなかったが、次の人がこの行を「重複排除の本体」と思って触る余地を残していた
- **もっともらしい失敗結果ほど疑うべきだった。** 変異テストのハーネスが 13 件すべて「捕まらない」と報告したとき、それは**ハーネス自身が壊れていた**（vitest 4 に存在しない `--reporter=basic` を渡していた）。全件が同じ結論に揃うこと自体が異常の兆候である
- **例外型の置き場所はテスト戦略に依存する。** `RateLimitError` を投げる側のモジュールに置くと、そのモジュールをモックするテストで `instanceof` が実行時に壊れる。型エラーは出ない
- **並行実行は「起きるかもしれない」ではなく「2 タブで必ず起きる」だった。** 起動契機を「ユーザーがページを開いたとき」に変えた瞬間、それまで考えなくてよかった競合が日常の操作になった。**契機を変えると、変えていないコードの前提が壊れる**
- **実機で確認した性質が、別の経路では成立していなかった。** 「リロードでは API を叩かない」をライトモードの実機ログで確認して満足したが、フルモードでは著者一覧を毎回叩いていた。**ユーザーはトークン未設定なので、この経路のログは永久に出ない。**実機確認は「試した経路」しか保証しない
- **削除を最後に回したのが効いた。** `src/feed/` を先に消していたら、型エラー 30 件超の中から本質的な作業を見分けることになっていた。最後に消したときのエラーは 3 件だけで、すべて `src/feed/` 自身が出したものだった

## Next Steps

- [x] **実機確認** — 通過（上記）。PRD の Phase 4b を complete に更新済み
- [ ] コミット
- [ ] Phase 6（候補一覧 UI）— 429 のバッジ表示とポップアップ文言もここ
- [ ] OQ-14（フルモードでの likes 再取得の間隔）は 4b では未実装のまま
