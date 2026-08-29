# Implementation Report: データ取得層 (Phase 4)

## Summary

公式 Atom フィードと Qiita API v2 だけで検出の入力を揃える層を実装した。conditional GET と `<updated>` 変化検知によるスキャン起動、レート枠に応じた 2 モード（ライト / フル）、DOMParser を使わない自前 Atom パーサ、アカウント単位の逆引きインデックス構築までを含む。

自動検証（型 / lint / テスト / ビルド / 配線）はすべて通過。**Chrome への読み込み確認は未実施**（下記「未完了」）。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | **Large**（一致） |
| Confidence | 8/10 | **8/10 相当** — 逸脱 4 件はいずれも局所修正で解決 |
| Files Changed | 15（CREATE 13 / UPDATE 2） | **17**（CREATE 12 / UPDATE 5） |
| Tests | 7 ファイル | **7 ファイル / 74 テスト** |
| カバレッジ目標 | 80% | **94.73%**（Statements） |

CREATE が 13 → 12 になったのは、計画が数えていた `src/api/` ディレクトリ作成をファイルとして数えていたため。UPDATE が 2 → 5 に増えた理由は逸脱 1・2 を参照。

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | 型の追加 | 完了 | `ScanMode` / `FeedSnapshot` / `ScanResult` |
| 2 | storage 層 | 完了 | 全 getter で検証を挟み、壊れた値は既定値へ |
| 3 | storage のテスト | 完了 | 12 テスト |
| 4 | Atom パーサ | 完了 | **本フェーズの中核**。DOMParser 非依存 |
| 5 | パーサのテスト | 完了 | 13 テスト。`<id>` 誤用の検知を含む |
| 6 | フィード取得 | 完了 | conditional GET ＋ `<updated>` の二段判定 |
| 7 | 取得のテスト | 完了 | 8 テスト |
| 8 | レート枠 | 完了 | 純粋関数のみ。storage も fetch も触らない |
| 9 | レート枠のテスト | 完了 | 13 テスト |
| 10 | API クライアント | 完了 | 型ガードで応答を検証。`verifyToken` は Phase 3 用に先行実装 |
| 11 | クライアントのテスト | 完了 | 13 テスト |
| 12 | スキャナ | 完了 | 直列実行 ＋ 残枠追跡 ＋ 打ち切り |
| 13 | スキャナのテスト | 完了 | 7 テスト。両モードの経路を検証 |
| 14 | service worker 配線 | 完了 | alarms 30 分 ＋ onStartup ＋ SCAN_NOW |
| 15 | 統合検証 | **部分完了** | Level 1〜3 通過。Level 4（実機）は未実施 |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Level 1: 静的解析 | **通過** | `tsc --noEmit` エラー 0 / `eslint .` エラー 0 |
| Level 2: ユニットテスト | **通過** | 75 テスト / 7 ファイル |
| Level 3: ビルド | **通過** | `vite build` 成功 |
| Level 3b: dist の配線 | **通過** | loader が別々の正しいチャンクを指す（下記） |
| Level 4: 実機確認 | **通過**（2 回目） | 1 回目で `items: 0` のバグを検出し修正 |
| Level 5: エッジケース | **通過** | 空入力 / 型不正 / 401 / 429 / ネットワーク断 / レート枯渇 |

### 配線検証の結果

```
service-worker-loader.js  ->  assets/service-worker.ts-DcQT7upz.js   (6.06 kB)
content script loader     ->  assets/content-script.ts-Bf9G7tK4.js   (0.51 kB)
```

Phase 2 で起きたチャンク名衝突は再発していない。service worker 側が 6 kB に増えているのは、スキャナ一式がバンドルされた結果であり期待どおり。

### カバレッジ

```
All files      | 94.73 % Stmts | 90 % Branch | 97.56 % Funcs | 96.17 % Lines
 scanner.ts    | 91.17 |  69.23 |  100 |  91.04
 qiita-client  | 93.75 |  92.10 |  100 |  97.67
 atom-parser   | 96.29 |  93.33 |  100 |   100
 storage.ts    | 96.42 |  94.73 |  100 |   100
```

計画の合格条件 80% を全指標で超えた。`scanner.ts` の分岐 69% は、フルモードの打ち切り経路（枠切れが複数箇所で起きるケース）が未到達なため。

## Files Changed

### 新規（12 ファイル / 1,310 行）

| File | Lines | Role |
|---|---|---|
| `src/lib/storage.ts` | 91 | storage の型付きアクセス |
| `src/lib/storage.test.ts` | 138 | 12 テスト |
| `src/feed/atom-parser.ts` | 85 | Atom パース（DOMParser 非依存） |
| `src/feed/atom-parser.test.ts` | 130 | 13 テスト |
| `src/feed/feed-fetcher.ts` | 59 | conditional GET と変化検知 |
| `src/feed/feed-fetcher.test.ts` | 101 | 8 テスト |
| `src/api/rate-budget.ts` | 66 | レート枠の判断（純粋関数） |
| `src/api/rate-budget.test.ts` | 90 | 13 テスト |
| `src/api/qiita-client.ts` | 152 | API クライアント |
| `src/api/qiita-client.test.ts` | 121 | 13 テスト |
| `src/background/scanner.ts` | 172 | スキャンのオーケストレーション |
| `src/background/scanner.test.ts` | 113 | 7 テスト |

### 更新（5 ファイル / +70 -6）

| File | Change |
|---|---|
| `src/types/domain.ts` | +25 — `ScanMode` / `FeedSnapshot` / `ScanResult` / `LocalState` 拡張 |
| `src/types/messages.ts` | +13 -4 — `SCAN_NOW` / `SCAN_ACCEPTED` を追加 |
| `src/background/service-worker.ts` | +30 — alarms とスキャン起動の配線 |
| `src/content/content-script.ts` | +7 -2 — 型ガードの絞り込み（逸脱 1） |
| `package.json` | +1 — `@vitest/coverage-v8`（逸脱 2） |

## Deviations from Plan

### 逸脱 1: content-script.ts の型ガードを PONG に絞った

- **WHAT**: `isPongResponse(value): value is QtgResponse` を `value is Extract<QtgResponse, { type: 'PONG' }>` に変更。計画では UPDATE 対象に挙げていなかったファイル
- **WHY**: Task 14 で `QtgResponse` を `PONG | SCAN_ACCEPTED` のユニオンにしたため、型ガードがユニオン全体にしか絞り込めず `response.version` が型エラーになった（TS2339）。**メッセージ型をユニオン化すると既存の型ガードが破れる**という、計画が予見していなかった連鎖

### 逸脱 2: `@vitest/coverage-v8` を開発依存に追加

- **WHAT**: 計画に無い依存を 1 つ追加
- **WHY**: 計画の Acceptance Criteria が「カバレッジ 80% 以上」を要求しているのに、計測手段が入っていなかった。**計画自身の不備**。追加しないと合格判定ができない

### 逸脱 3: `chrome.alarms.create` に `void` を付けた

- **WHAT**: `chrome.alarms.create(...)` → `void chrome.alarms.create(...)`
- **WHY**: MV3 の `alarms.create` は Promise を返すため `@typescript-eslint/no-floating-promises` が発火した。await する必要は無い（登録の完了を待つ意味がない）ので `void` で意図を明示した

### 逸脱 4: `qiita-client.ts` に `verifyToken` を先行実装

- **WHAT**: Phase 3（トークン設定 UI）が使う関数を本フェーズで実装
- **WHY**: 計画の Task 10 に記載済みの意図的な先行実装。`request()` の共通処理を再利用でき、Phase 3 側は呼ぶだけで済む

## Issues Encountered

### 問題 1: `src/api/` が存在せず heredoc が失敗

- **症状**: `bash: src/api/rate-budget.ts: No such file or directory`
- **原因**: Write ツールは中間ディレクトリを自動作成するが、シェルの `>` はしない。`src/feed/` は Write で作られていたので気づかなかった
- **解決**: `mkdir -p src/api` を先に実行

### 問題 2: メッセージ型のユニオン化が既存の型ガードを壊した

- **症状**: `Property 'version' does not exist on type '{ type: "SCAN_ACCEPTED"; }'`
- **教訓**: **判別可能ユニオンを増やすときは、既存の型ガードの戻り型を見直す。**`value is Union` は「ユニオンのどれか」までしか絞らない。具体型が要るなら `Extract` で絞る

### 問題 3: カバレッジ計測手段が計画に含まれていなかった

- **症状**: `MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'`
- **教訓**: **合格条件に数値目標を書くなら、それを測る手段も計画に含める。**Phase 2 は「カバレッジを合格条件にしない」と明示していたため露見しなかった

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `src/lib/storage.test.ts` | 12 | 既定値 / 往復 / 空文字の扱い / 壊れた値のフォールバック |
| `src/feed/atom-parser.test.ts` | 13 | ルート updated の取り違え防止 / `<id>` 誤用の検知 / 欠損 entry の切り離し / 不正 XML |
| `src/feed/feed-fetcher.test.ts` | 8 | If-None-Match の付与 / 304 / updated 不変 / 変化検知 / 各種失敗 |
| `src/api/rate-budget.test.ts` | 13 | ヘッダー解析 / 空文字を 0 と誤読しない / 余白の適用 / モード判定 |
| `src/api/qiita-client.test.ts` | 13 | Authorization の有無 / 要素単位の除外 / Total-Count / 401 / 429 |
| `src/background/scanner.test.ts` | 7 | unchanged で API 不発 / 両モードの経路 / 打ち切り / 部分失敗の継続 |
| **合計** | **74** | Statements 94.73% |

## 実機確認の結果

### 1 回目 — バグ検出

```
[QTG] feed updated: 2026-08-19T05:00:00+09:00 items: 0
[QTG] scan finished: mode=light items: 0 likes: 0 truncated: false
```

**フィードは取得できたのに entry が 30 件すべて落ちた。**ユニットテスト 13 件は全通過していた。

### 原因 — 記事 URL の UTM パラメータ

実データの href は次の形だった:

```
https://qiita.com/{handle}/items/{itemId}?utm_campaign=...&amp;utm_medium=...&amp;utm_source=...
```

正規表現が `([^/"?#]+)"` と item_id の直後に `"` を要求していたため、`?` で止まって全件マッチ失敗した。

**なぜ計画段階で見逃したか（本件の本質）**

計画作成時に実フィードを取得して構造を確認したが、**報告時に URL を丸ごとマスクしていた。**その結果クエリの存在が視界から消え、「実測した」つもりで加工後の文字列を設計根拠にしていた。テストのフィクスチャもその誤った理解のまま作ったため、テストは通り続けた。

Phase 2 の「ビルド成功・型 OK・lint OK・テスト全通過でも service worker が実行されていなかった」と同種の、**検証したつもりの失敗**である。

### 修正

- `ITEM_LINK_PATTERN` にクエリの読み飛ばし `[^"]*` を追加。`url` はクエリを除いた正規化 URL とする
- **テストのフィクスチャを実データと同じ UTM 付きに変更**（これを模さない限り、同じバグが再発しても検知できない）
- UTM が付かない形でも動くケースを追加（Qiita が外した場合への備え）

### 2 回目 — 通過

```
[QTG] feed updated: 2026-08-19T05:00:00+09:00 items: 30
[QTG] scan started: mode=light items: 30
[QTG] scan finished: mode=light items: 30 likes: 591 truncated: false rate-remaining: 30
```

`likeIndex` にアカウントが格納されたことを Extension Storage で確認。**レート消費は 60 → 30 で PRD の試算（ライトモード 約 30 req）と一致**した。

### 3 回目 — 変化検知の確認

拡張機能をリロードし、`onInstalled` の再発火でスキャンが起動しても、フィードの時点で止まることを確認した。

```
[QTG] service worker booted 0.1.0
[QTG] installed: update version: 0.1.0
[QTG] scan skipped: feed unchanged
```

`scan started` に進まず API 呼び出しが 0 件。**PRD の Success signal「`<updated>` が変わらない限りスキャンが走らない」を満たした。**

## Phase 4 の完了判定

| Success signal（PRD） | 結果 |
|---|---|
| 1 回のスキャンでトレンド 30 件分の likers が `created_at` 付きで storage に入る | **達成**（30 件 / 591 レコード） |
| `<updated>` が変わらない限りスキャンが走らない | **達成**（3 回目の確認） |

## コードレビューでの指摘と修正

`/code-review`（ローカルモード）で HIGH 2 件を検出し、いずれも修正した。CRITICAL はゼロ。

### H-1: 外部由来の値を未検証で API パスに埋め込んでいた

`itemId` と `authorHandle` は Atom フィード（外部データ）由来だが、パーサに形式検証が無く、
そのまま `/items/{itemId}/likes` や `/users/{handle}/items` に入っていた。
抽出パターンは handle が `[^/"]+` なので `?` `#` `..` を通す。
`..` が入ると `/users/../items` が正規化されて **別のエンドポイントを叩く**。

実際の Qiita ハンドルでは発火しないが、フィードの形式変更で成立しうる。

**修正**

- `atom-parser.ts` に形式検証を追加（`ITEM_ID_PATTERN` / `HANDLE_PATTERN`）。
  想定外の形式は entry 単位で落とす。長さは固定せず文字種のみ検証した
  （桁数変更で正当な記事を落とすほうが害が大きいため）
- `qiita-client.ts` でパスに入れる値を `encodeURIComponent` に通す（多層防御）
- 回帰テストを 3 件追加（`..` / クエリ記号 / 想定外の item_id）

### H-2: `runScan()` が 100 行・ネスト 5 段だった

プロジェクト規約は関数 50 行以内・ネスト 4 段以内。
フルモードの追加取得が `if > for > try > for > if` と深く、打ち切り判定が 3 箇所に散っていた。

**修正** — 5 つの関数に分割した。進捗は `ScanProgress` として新しいオブジェクトで受け渡す。

| 関数 | 行数 | 役割 |
|---|---|---|
| `scanOneItem()` | 24 | 記事 1 件の likers 取得と畳み込み |
| `scanItems()` | 15 | 記事列の走査と打ち切り |
| `scanAuthor()` | 25 | 著者 1 人の過去記事 |
| `scanAuthorHistory()` | 15 | 著者の巡回 |
| `persistScan()` | 30 | 結果の組み立てと保存 |
| `runScan()` | **33** | オーケストレーションのみ |

**全関数が 50 行以内、ネストは最大 2 段**になった。既存のスキャナテスト 7 件が変更なしで通ることで
挙動不変を担保している。

### MEDIUM（未対応・意図的）

`storage.ts` の `as LikeIndex` / `as ScanResult` は構造を検証していない。
ただし自分で書いた値であり、壊れていれば既定値へフォールバックする設計のため許容とした。
Phase 5 でインデックス構造が確定した段階で再検討する。

### 修正後の再検証

| Check | Result |
|---|---|
| Type check | Pass |
| Lint | Pass |
| Tests | Pass（**78 件**、+3） |
| Coverage | **96%**（94.73% から改善） |
| Build | Pass |
| dist の配線 | Pass |

## セキュリティレビュー

`/security-review` を実施。**CRITICAL 0 / HIGH 0 / MEDIUM 2 / LOW 2**。

### 合格した項目

| 項目 | 根拠 |
|---|---|
| Secrets | ハードコードなし。トークンは `storage.local` のみ（`sync` 未使用）。追跡対象への混入なし |
| 送信先の固定 | `//evil.example` / `@` 埋め込み / スキーム混入のいずれでも `host=qiita.com` のままであることを実証 |
| content script の露出 | 使う chrome API は `runtime.sendMessage` のみ。**`chrome.storage` に触れずトークンに到達できない** |
| 権限の最小性 | `storage` / `alarms` と `https://qiita.com/*` のみ |
| 依存 | `npm audit` 0 vulnerabilities（dev 含む） |
| レート制限 | `Rate-Remaining` を追跡し余白 5 で自主的に打ち切る |

SQL Injection / CSRF / RLS は該当機能なし。**XSS は現状 DOM 書き込みが無いため N/A だが、Phase 7（DOM 非表示）で再評価が必要**。

### M-1: `encodeURIComponent` が `..` を防がない（修正済み）

H-1 の修正で「多層防御」としてエンコードを入れたが、**`encodeURIComponent(".." ) === ".."`** であり
`.` はエンコード対象外。`/users/../../admin/items` が `/api/admin/items` に潰れることを実証した。
つまり防御はパーサの `HANDLE_PATTERN` 単層だった。

**修正** — `qiita-client.ts` に `toSafeSegment()` を追加し、`/^[A-Za-z0-9_-]+$/` を満たさない値は
`QtgError` を投げて **fetch 自体を行わない**。パーサを経由しない呼び出しでも安全になった。
回帰テストを 5 件追加（`..` / クエリ記号 / 空文字 / 正常系）。

### 未対応（意図的・完成前に実施）

| # | 内容 | 対応方針 |
|---|---|---|
| M-2 | `.env.local` に実トークンが平文で残存。拡張機能はこれを読まない（OQ-7 実測用に作ったもの） | **完成前に削除する**（Phase 3 の動作確認まで使い回す） |
| L-1 | スクラッチパッドに実データが残存（`feed.xml` / likes 応答 JSON / `me.json` / 旧 PRD バックアップ） | **完成前に削除する** |
| L-2 | ログに実 item_id・ハンドルが出る | 動作上は問題なし。**Phase 10 でコンソールのスクリーンショットを載せる場合は要マスク** |

### 修正後の再検証

| Check | Result |
|---|---|
| Type check | Pass |
| Lint | Pass |
| Tests | Pass（**83 件**） |
| Coverage | **96.06%** |
| Build | Pass |
| dist の配線 | Pass |

## コードレビュー 2 回目（修正後の再レビュー）

1 回目の修正とセキュリティレビューを終えたコードを、**実装を読んで correctness の観点で**再レビューした。
1 回目は機械的チェック（行数・console・any・絵文字）が中心で、ロジックを追っていなかった。

### H-3: 打ち切り時にフィードを「処理済み」として保存していた（修正済み）

`persistScan()` が `truncated` の値に関わらず `saveFeedCache()` を呼んでいた。結果として:

1. レート枠が足りず 30 件中 15 件で打ち切る
2. `feedUpdated` が保存される
3. 次回スキャンは `<updated>` 不変でスキップされる
4. **残り 15 件は次のフィード更新（約半日後）まで取得されない**

計画の Task 12 には「打ち切り時も取得済み分を保存し、**次回に続きから積める形にする**」と書いていたが、
実装は保存だけして再取得の道を塞いでいた。**計画の意図を実装が満たしていなかった**ケースである。

**実害**: 検出は不完全なインデックスで走る。共起クラスタは「N 人が M 本に共通していいね」で判定するため、
記事が半分欠けると共起が成立せず見逃すか、少ない母数で誤検知する。適合率が唯一の成功指標である以上、無視できない。

**修正** — 完走したときだけ `saveFeedCache()` を呼ぶ。取得済みインデックスの保存は打ち切り時も行う。

### M-3: item_id のパターンが厳しすぎた（修正済み）

| 場所 | 修正前 | 修正後 |
|---|---|---|
| `atom-parser.ts` | `/^[0-9a-z]+$/`（小文字のみ） | `/^[0-9a-zA-Z]+$/` |
| `qiita-client.ts` | `/^[A-Za-z0-9_-]+$/` | 変更なし |

実測 30 件はすべて小文字だったが、観測は 1 回きり。大文字が現れると記事を落とすため緩めた。
クライアント側の最終防衛線は変わらないので安全性は落ちない。

### L-4: 打ち切り時の保存挙動にテストが無かった（修正済み）

**これが H-3 を見逃した直接の原因。**83 テストが全通過していても、
`truncated` のときに `saveFeedCache` が呼ばれるかを誰も検証していなかった。

回帰テストを 3 件追加し、**修正を一時的に戻すと確かに失敗すること**を確認した
（バグ状態: 1 failed / 9 passed → 修正後: 10 passed）。テストが実際にバグを捕まえる保証を取っている。

### 未対応

| # | 内容 | 判断 |
|---|---|---|
| M-4 | `storage.getLikeIndex` / `getLastScanResult` が本番コードから未使用 | Phase 5 / 6 で使う先行実装。storage 層の完全性として許容 |
| L-3 | `persistScan()` の引数が 6 個 | 型で守られている。分割すると却って追いにくい |

### 再検証

| Check | Result |
|---|---|
| Type check / Lint / Build / 配線 | Pass |
| Tests | Pass（**86 件**） |
| Coverage | **96.08%** |

## 未完了

- [x] `/code-review` によるレビュー（HIGH 2 件を検出・修正済み）
- [ ] コミット（pre-commit フックに約 4 分かかる）
- [ ] **完成前**: `.env.local` の削除（実トークンが平文で残っている）
- [ ] **完成前**: スクラッチパッドの実データ削除（第三者のアカウント情報を含む）

## Next Steps

- [ ] 実機確認（上記）
- [ ] `/code-review` でレビュー
- [ ] Phase 3（トークン設定 UI）— `verifyToken` と `storage.saveToken` は実装済みなので、UI を載せるだけ
- [ ] Phase 5（検出エンジン）で **OQ-12**（ライトモードの射程で一次証拠のクラスタを捕まえられるか）を検証する

---

*Generated: 2026-08-19*
*Plan: `.claude/PRPs/plans/completed/data-fetch-layer.plan.md`*
*Source PRD: `.claude/PRPs/prds/qiita-trend-cleaner.prd.md` — Phase 4*
