# Implementation Report: 基盤構築 (Foundation Scaffold)

## Summary

Qiita Trend Guard の土台を構築した。Vite 8 + TypeScript 6 による Manifest V3 のビルド構成、`manifest.config.ts`、service worker と content script の骨格、Phase 4〜8 が契約として使う型定義、そして**DOM セレクタを 1 ファイルに隔離し `.style-*` の使用をテストで機械的に禁止する構造**を確立した。

自動検証（型チェック / lint / テスト / ビルド）はすべて通過。**Chrome への読み込み確認は未実施**（下記「未完了」参照）。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | **Medium**（一致） |
| Confidence | 8/10 | **実測 8/10 相当** — 逸脱 4 件はいずれも局所修正で解決 |
| Files Changed | 18（Metadata の記載） | **25** — Metadata が過小。Files 表自体は 24 相当を列挙していた |
| Tests | 8 件前後 | **8 件** |
| 依存パッケージ | 9 指定 | 10 パッケージ / 193 モジュール |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | プロジェクト初期化 | 完了 | @crxjs は **2.7.1**。GOTCHA の 2.x 確認を満たす |
| 2 | TypeScript 設定 | 完了 | 後に `allowImportingTsExtensions` を追加（逸脱 2） |
| 3 | manifest.config.ts | 完了 | `permissions` / `host_permissions` の分離をビルド後に検証済み |
| 4 | vite.config.ts | 完了 | import に拡張子を付与（逸脱 2） |
| 5 | 型定義 | 完了 | `domain.ts` 89 行 / `messages.ts` 5 行 |
| 6 | DOM セレクタ層 | 完了 | **本フェーズの中核**。45 行 |
| 7 | ログ・エラー | 完了 | `errors.ts` を `ErrorOptions` 方式に変更（逸脱 1） |
| 8 | service worker 骨格 | 完了 | PING → PONG |
| 9 | content script 骨格 | 完了 | 型アサーションを型ガードに変更（逸脱 3） |
| 10 | テスト基盤・セレクタ検査 | 完了 | モックの `async` を除去（逸脱 4） |
| 11 | UI プレースホルダ | 完了 | popup / options 各 2 ファイル |
| 12 | Lint / Format 設定 | 完了 | `allowDefaultProject` を追加（逸脱 4） |
| 13 | アイコン・README | 完了 | PNG は Node で自前生成（外部ツール不要） |
| 14 | 統合確認 | 完了 | Chrome で実機確認済み。問題 5 を発見・修正して再確認 |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Level 1: 静的解析 | **通過** | `tsc --noEmit` エラー 0 / `eslint .` エラー 0 |
| Level 2: ユニットテスト | **通過** | 8 テスト / 1 ファイル。整形後の回帰も確認 |
| Level 3: ビルド | **通過** | `vite build` 成功。dist に 14 成果物 |
| Level 4: 統合 | **通過**（人手） | Chrome で実機確認。**この段階でのみ問題 5 が露見した** |
| Level 5: エッジケース | **通過** | Snackbar 不在 / 本文欠落 / uuid 差異 の 3 種をテストで網羅 |

### マニフェスト検証結果

ビルド成果物 `dist/manifest.json` を実際に読んで確認した内容:

- `permissions`: `["storage", "alarms"]`
- `host_permissions`: `["https://qiita.com/*"]`
- `background`: `{ "service_worker": "service-worker-loader.js", "type": "module" }`
- `content_scripts`: `[{ "matches": ["https://qiita.com/*"], "run_at": "document_idle" }]`

計画の GOTCHA「`storage` / `alarms` は `permissions`、qiita.com は `host_permissions`」を満たしている。

## Files Changed

すべて新規作成（25 ファイル / TS+JS 合計 417 行）。

| File | Action | Size |
|---|---|---|
| `package.json` | CREATED | 28 行 |
| `tsconfig.json` | CREATED | 22 行 |
| `vite.config.ts` | CREATED | 16 行 |
| `manifest.config.ts` | CREATED | 26 行 |
| `eslint.config.js` | CREATED | 21 行 |
| `.prettierrc.json` | CREATED | 6 行 |
| `.prettierignore` | CREATED | 5 行（計画外・逸脱 4） |
| `.gitignore` | CREATED | 5 行 |
| `README.md` | CREATED | 39 行 |
| `src/types/domain.ts` | CREATED | 89 行 |
| `src/types/messages.ts` | CREATED | 5 行 |
| `src/dom/selectors.ts` | CREATED | 45 行 |
| `src/dom/selectors.test.ts` | CREATED | 76 行 |
| `src/lib/logger.ts` | CREATED | 12 行 |
| `src/lib/errors.ts` | CREATED | 14 行 |
| `src/background/service-worker.ts` | CREATED | 20 行 |
| `src/content/content-script.ts` | CREATED | 36 行 |
| `src/test/setup.ts` | CREATED | 51 行 |
| `src/ui/popup/index.html` | CREATED | 19 行 |
| `src/ui/popup/main.ts` | CREATED | 3 行 |
| `src/ui/options/index.html` | CREATED | 19 行 |
| `src/ui/options/main.ts` | CREATED | 3 行 |
| `public/icons/icon-16.png` | CREATED | 79 B |
| `public/icons/icon-48.png` | CREATED | 124 B |
| `public/icons/icon-128.png` | CREATED | 307 B |

**計画にあったが作らなかったもの**: `tsconfig.node.json` — 単一 tsconfig で `vite.config.ts` / `manifest.config.ts` を include すれば足り、プロジェクト参照を分ける必要がなかった。

## Deviations from Plan

### 逸脱 1: `QtgError` の `cause` をパラメータプロパティで宣言しない

- **WHAT**: 計画の `constructor(message: string, readonly cause?: unknown)` を `constructor(message: string, options?: ErrorOptions)` に変更
- **WHY**: `Error` は ES2022 でネイティブに `cause` を持つ。パラメータプロパティで再宣言すると `noImplicitOverride: true` と衝突する。ネイティブの `ErrorOptions` を使う方が正しく、`new QtgError(msg, { cause: e })` という標準的な書き方になる

### 逸脱 2: `allowImportingTsExtensions` を追加し import に拡張子を付与

- **WHAT**: `tsconfig.json` に `allowImportingTsExtensions: true` を追加し、`vite.config.ts` の import を `./manifest.config` → `./manifest.config.ts` に変更
- **WHY**: Vite 8 が警告を出した — 「`configLoader: 'native'`（将来のデフォルト）では拡張子なし import は非対応」。将来のメジャーバージョンで壊れるため先回りして解消した

### 逸脱 3: 型アサーションを型ガードに置き換え

- **WHAT**: `content/index.ts` の `(await sendMessage(req)) as QtgResponse | undefined` を、`isPongResponse(value): value is QtgResponse` という実行時検証を伴う型ガードに変更
- **WHY**: `@typescript-eslint/no-unnecessary-type-assertion` が発火した。単にキャストを外すのではなく型ガードにしたのは、content script が**別コンテキストからのメッセージを受け取る**境界であり、実行時の形式検証が本来正しいため（ECC の「外部データを信用しない」原則）

### 逸脱 4: 計画外のファイルを 2 つ追加、1 つを不作成

- **WHAT**: `.prettierignore` を追加。`tsconfig.node.json` を作らなかった。`eslint.config.js` に `allowDefaultProject` を追加
- **WHY**:
  - `.prettierignore` — Prettier が `.claude/` 配下の PRD と実装計画のテーブル整形まで書き換えてしまうため、除外が必須だった
  - `tsconfig.node.json` — 単一 tsconfig で足りた（上記）
  - `allowDefaultProject` — `eslint.config.js` 自身が tsconfig の include 外にあり、project service が解決できずパースエラーになった

### 逸脱 5: エントリポイントを `index.ts` にしない（NAMING_CONVENTION の修正）

- **WHAT**: 計画の `NAMING_CONVENTION` は「エントリポイント: `index.ts`」と定めていたが、これを撤回。`src/background/service-worker.ts` と `src/content/content-script.ts` に改名した
- **WHY**: **この規約自体がバグの原因だった**（下記「問題 5」）。@crxjs はエントリのファイル名からチャンク名を導出するため、`src/background/index.ts` と `src/content/index.ts` の basename 衝突により両ローダーが同一チャンクを指した
- **後続への影響**: **Phase 3 以降で追加するエントリポイントも、必ず一意な basename にすること。**`index.ts` は使わない。HTML エントリ（`src/ui/*/index.html`）はディレクトリ構造が保たれるため影響を受けない

## Issues Encountered

### 問題 5: @crxjs のチャンク名衝突により service worker が一度も実行されなかった

**Chrome の拡張機能エラーとして実際に表面化した唯一の不具合。**

- **症状**: `chrome://extensions` にエラーバッジ。スタックフレームが `assets/logger-BBvPiycG.js:1 (無名関数)` を指す
- **一見の誤診**: minify された `export{t}` が見えるため「content script が ES モジュールとして読めていない構文エラー」に見える。**実際は構文エラーではなくスタックフレーム**
- **真の原因**: `src/background/index.ts` と `src/content/index.ts` の basename 衝突。ビルド成果物を読むと配線が壊れていた。

  ```
  service-worker-loader.js  ->  import './assets/index.ts-Bf9G7tK4.js'   <- content script のチャンク
  content script loader     ->  import('assets/index.ts-Bf9G7tK4.js')    <- 同じチャンク
  assets/index.ts-DHlDePC0.js (本物の service worker) はどこからも参照されず
  ```

- **エラーに至る連鎖**:
  1. service worker が content script のコードを読み込む
  2. 本物の service worker（`onMessage` リスナーを登録する側）が一度も実行されない
  3. content script のコードが service worker 内で `ping()` を実行し、`chrome.runtime.sendMessage` の受け手が存在せず reject
  4. `catch` が `logger.error('failed to reach service worker:', ...)` を呼ぶ
  5. **Chrome は拡張機能内の `console.error` を「エラー」として収集する**ため、`logger` モジュールがスタックフレームとして表示された
- **解決**: エントリを `service-worker.ts` / `content-script.ts` に改名。修正後の配線を検証済み。

  ```
  service-worker-loader.js  ->  assets/service-worker.ts-DHlDePC0.js   (SERVICE WORKER)
  content script loader     ->  assets/content-script.ts-Bf9G7tK4.js   (CONTENT SCRIPT)
  ```

- **教訓 1**: **`try/catch` でエラーを握りつぶさずログに残した設計が、根本原因への唯一の手がかりになった。**計画の ERROR_HANDLING 方針がそのまま効いた
- **教訓 2**: **ビルドが成功し、型・lint・テストが全通過しても、成果物の配線が壊れていることがある。**Level 3（ビルド成功）は「正しく動く」を意味しない。`dist/` の中身を実際に読む検証を Level 3 に追加すべきだった

### 問題 1: Git Bash の `$PATH` が壊れており `node` も `ls` も見つからない

- **症状**: `node: command not found`、続いて `ls: command not found`
- **原因**: `$PATH` が Windows 形式（`;` 区切り）と POSIX 形式（`:` 区切り）の混在で、Git Bash が `/usr/bin` を解決できていなかった。`C:\Program Files\nodejs` は PATH 文字列に含まれていたが、区切り文字の解釈が破綻していた
- **解決**: すべての Bash 呼び出しの先頭で `export PATH="/usr/bin:/bin:/mingw64/bin:/c/Program Files/nodejs"` を明示。Node.js v24.13.1 / npm 11.8.0 は正常にインストールされていた
- **後続への影響**: **Phase 3 以降のすべての Bash 実行で同じ PATH 設定が必要**

### 問題 2: 主要パッケージが計画執筆時の想定より新しいメジャーバージョン

- **症状**: TypeScript 6.0.3 / ESLint 10.8.1 / Vite 8.2.1 / Vitest 4.1.10 が入った
- **影響**: 逸脱 1・2・4 はいずれもこれに起因する（`noImplicitOverride` の厳格化、Vite 8 の config loader、ESLint 10 の project service）
- **解決**: すべて検証ループで検出し、局所修正で解消。バージョンを下げる必要はなかった

### 問題 3: 場当たりの `grep '\.style-'` がドキュメントコメントを誤検知

- **症状**: `selectors.ts` の「`.style-5ctx60` 等を書かないこと」という**禁止事項の説明文**に grep が反応した
- **教訓**: **計画が「ファイル全文の grep ではなく `Object.values(SELECTORS)` を検査する」と定めていたのは、まさにこれを避けるためだった。**正式なテストは誤検知しない

### 問題 4: Bash コマンドの長さ制限で大きな heredoc が壊れる

- **症状**: 140 行を超える heredoc が `unexpected EOF while looking for matching '` で失敗（本レポート生成時と PRD 生成時の 2 回）
- **原因**: コマンド文字列が途中で切り捨てられ、heredoc の終端行が失われる
- **解決**: 大きなファイルは Write ツールを使う。Bash の heredoc は中小規模のファイルに留める
- **後続への影響**: Phase 3 以降でも、100 行を超えるファイルは Write ツールで作成すること

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `src/dom/selectors.test.ts` | 8 | セレクタのハッシュクラス非依存（2）／Snackbar 読み取り（2）／フェイルセーフ（2）／既定値（1）／chrome モック往復（1） |

**カバレッジ方針**: 計画どおり、本フェーズは数値カバレッジを合格条件にしない。成果物の大半が設定ファイルと骨格であるため。**合格条件は「セレクタ層のテストが存在し `.style-*` 禁止が機械的に強制されていること」**で、これは満たしている。

## 実機確認の結果

**PRD の Success signal「未パック拡張として読み込め、トレンドページで content script が動作する」を満たした。**

| 確認項目 | 結果 |
|---|---|
| `dist/` を未パック拡張として読み込める | ✅ |
| エラーバッジが出ていない | ✅（問題 5 の修正後） |
| service worker の DevTools に `[QTG] service worker booted 0.1.0` | ✅ |
| Elements に `<html data-qtg-injected="0.1.0">` | ✅ |
| **トレンド記事の見た目が変わっていない** | ✅ スコープ厳守 |

### marker の存在が疎通の証拠になる

`data-qtg-injected` に値が入る経路は 1 本しかない。

```
content script が sendMessage
  -> service worker が { type: 'PONG', version } を返す
  -> isPongResponse() の実行時検証を通過
  -> markInjected(response.version)  <- ここで初めて属性が付く
```

属性値 `0.1.0` は **service worker 側の `chrome.runtime.getManifest().version` 由来**であり、DOM 属性はページ読み込みをまたいで残らない。したがって **その読み込みで content script ⇄ service worker の往復が成立したことが確定する。**

Console にログが出ていなかったのは、**DevTools をページ読み込みより後に開いたため**（Chrome は DevTools を開く前のコンソール出力を保持しない）。marker の方が強い証拠であり、機能上の問題ではない。

## Next Steps

- [ ] `git init` — 現在このディレクトリは git リポジトリではない。25 ファイルを作成済みなので初回コミットで全体を捕捉できる
- [ ] `/code-review` によるレビュー
- [ ] Phase 3（トークン設定 UI）/ Phase 4（データ取得層）の計画作成 — この 2 つは並行可能
- [ ] **Phase 3 以降の計画では、Level 3（ビルド）に「`dist/` の配線検証」を必ず含める**（問題 5 の教訓）

---

*Generated: 2026-08-18*
*Plan: `.claude/PRPs/plans/completed/foundation-scaffold.plan.md`*
*Source PRD: `.claude/PRPs/prds/qiita-trend-cleaner.prd.md` — Phase 2*
