# Implementation Report: トークン設定 UI (Phase 3)

## Summary

options ページにアクセストークンの入力・検証・保存・削除の UI を実装した。トークンは任意設定であり、未設定でもライトモードで検出は動く。UI の役割は「使えるようにする」ことではなく「**検出の射程を広げる**」手段を提供し、いまどちらのモードで動いているかを明示することにある。

自動検証（型 / lint / テスト / ビルド / 配線）と実機確認をすべて通過した。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | **Medium**（一致） |
| Confidence | 8/10 | **9/10 相当** — 逸脱ゼロ |
| Files Changed | 6（CREATE 2 / UPDATE 4） | **6**（一致） |
| Tests | 新規 | **+21**（86 → 107） |
| カバレッジ目標 | 80% | **96.45%**（token-form.ts は 95.65%） |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | `verifyToken` の戻り値を拡張 | 完了 | boolean → `{ ok } \| { ok: false; reason }` |
| 2 | `verifyToken` のテスト更新 | 完了 | 401 / 403 / 通信失敗 / 500 を区別 |
| 3 | `token-form.ts` | 完了 | DOM を参照しない状態遷移ロジック |
| 4 | `token-form.test.ts` | 完了 | 18 テスト |
| 5 | `index.html` | 完了 | モード表示・フォーム・取得手順 |
| 6 | `main.ts` | 完了 | DOM 配線のみ |
| 7 | 統合検証 | 完了 | Level 1〜4 すべて通過 |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Level 1: 静的解析 | **通過** | 型エラー 0 / lint エラー 0 |
| Level 2: ユニットテスト | **通過** | 107 テスト / 8 ファイル |
| Level 3: ビルド | **通過** | `dist/src/ui/options/index.html` 生成を確認 |
| Level 3b: dist の配線 | **通過** | loader が別々の正しいチャンクを指す |
| Level 4: 実機確認 | **通過** | 全項目 PASS（下記） |
| Level 5: エッジケース | **通過** | 空入力 / 空白のみ / 401 / 403 / 通信失敗 / 500 |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `src/ui/options/token-form.ts` | CREATED | 99 |
| `src/ui/options/token-form.test.ts` | CREATED | 159 |
| `src/ui/options/index.html` | UPDATED | 19 → 112 |
| `src/ui/options/main.ts` | UPDATED | 3 → 82 |
| `src/api/qiita-client.ts` | UPDATED | +19 / -4 |
| `src/api/qiita-client.test.ts` | UPDATED | +31 / -4 |

## Deviations from Plan

**なし。** 計画どおりに実装した。

## Issues Encountered

**なし。** Phase 4 で storage / API クライアント / レート定数が揃っていたため、本フェーズは既存部品の組み合わせで済んだ。

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `src/ui/options/token-form.test.ts` | 18 | マスク / モード文言 / 状態読み込み / 検証と保存 / 削除 |
| `src/api/qiita-client.test.ts`（更新） | +3 | 403 / 通信失敗 / 500 の区別 |

### 特に固定した性質

- **401 でも通信失敗でも保存しない**（無効なトークンを storage に残さない）
- **無効と通信失敗で文言が異なる**（通信断を「トークンが無効」と言わない）
- **マスク結果に元の値が含まれない**。12 文字以下は全マスク。中央のマスク幅は固定で長さを推測させない
- **エラーメッセージにトークンを含めない**
- 前後の空白を落としてから検証する（コピペで混ざるため）

## セキュリティ上の実装

| 対策 | 実装 |
|---|---|
| 入力の秘匿 | `type="password"` ＋ `autocomplete="off"`（パスワードマネージャに拾わせない） |
| 保存値の非表示 | 画面へ返すのはマスク済み文字列のみ。生のトークンは `TokenState` に載せない |
| 入力欄のクリア | 保存成功後に `input.value = ''` |
| 二重送信の防止 | 確認中は保存ボタンを `disabled`（レート枠の無駄を防ぐ） |
| ログ | トークンの値を `logger` に渡している箇所は**コードベース全体で 0 件**を維持 |
| 外部リンク | `rel="noreferrer"` を付与 |

暗号化保存は**行わない**。`storage.local` は拡張のサンドボックス内にあり、暗号化しても復号鍵を同じ場所に置くことになり実効性がないため。

## 実機確認の結果（全項目 PASS）

| 確認項目 | 結果 |
|---|---|
| 未設定でライトモード表示（トレンド 30 件・60 req） | PASS |
| 無効なトークンで「受け付けられませんでした」＋**保存されない** | PASS |
| 有効なトークンでフルモードへ切り替わりマスク表示になる | PASS |
| 削除でライトモードに戻る | PASS |
| リロード後も状態が保持される | PASS |

**PRD の Success signal を満たした。**「トークンを入力すると疎通確認が通りフルモードに切り替わる。未設定時はライトモードで動作中であることが UI に明示される」。

Phase 4 で 2 度（チャンク名衝突・UTM パラメータ）実機で初めて壊れが露見したが、**本フェーズは一発で通った**。既存部品（storage / qiita-client / rate-budget）が実測で固まっており、新規に外部データを解釈する処理が無かったことが効いている。

## orch-review（マルチエージェントレビュー）の結果と修正

5 エージェント（quality / typescript / security ＋ 敵対的検証 2）を並列実行。
**blocking 2 件・advisory 2 件**。blocking はいずれも敵対的検証で `isReal: true`（confidence 0.9）。

### H-4: UI が実際の動作と逆のことを主張していた（修正済み）

保存済みトークンがある人が差し替えに失敗すると:

1. `submitToken` は正しく保存をスキップし、古いトークンは storage に残る
2. しかし戻り値が `{ kind: 'error' }` で**前の状態を持たない**
3. `describeMode` が `error` をライトモードの文言にフォールバック
4. `main.ts` の `saved.hidden = state.kind !== 'full'` で**削除ボタンごと消える**
5. 一方 scanner は storage を読んで**フルモードで動き続ける**

検証エージェントは**空フォーム送信でも同じ経路に入る**ことを追加で指摘した。

**修正** — `error` という状態を廃止した。失敗は状態ではなくメッセージである。

```ts
export type SettledState =
  | { kind: 'light'; message?: string }
  | { kind: 'full'; masked: string; message?: string };
```

`kind` は storage の実態と必ず一致する。失敗時は `loadState()` で保存状態を読み直し、
その上にメッセージだけ載せる。回帰テストを 5 件追加し、401 / 通信失敗 / 空フォームの
いずれでも `kind: 'full'` が維持されることを固定した。

### H-5: storage の Promise 拒否を握りつぶしていた（修正済み）

`void handleSubmit()` / `void handleRemove()` に catch が無く、`handleSubmit` は
try/**finally**（catch なし）、`handleRemove` は try すら無かった。
`chrome.storage.local` が reject すると（`npm run dev` の HMR 中に頻発する
"Extension context invalidated"）、logger を通らず UI が「確認中」で固まる。

**修正** — 両ハンドラに catch を追加し、同ファイルの `init().catch(...)` と揃えた。
`showMessage()` はモード表示に触れずメッセージだけ出す（保存状態が不明な場面で断定しない）。

### なぜ自前の 3 回の検証が H-4 を見逃したか

- `token-form.test.ts` の submit 系テストが**すべて空の storage から始まっていた**
- `main.ts` にテストが 1 つも無い
- 依頼した実機確認も「未設定 → 無効トークン」の順で、**既存トークンがある状態を通らなかった**

## UI 改善と、そこで作り込んだ CSS のバグ

ユーザーの指摘で削除ボタンを「設定済みのトークン」表示の横へ移した。
破壊的操作は対象の隣にあるべきで、とくにマスク表示は中身が見えないため
「どれを消すのか」が視覚的に固定されている必要がある。

**このとき `.saved { display: flex }` を追加したことで `hidden` 属性が効かなくなった。**
UA スタイルの `[hidden] { display: none }` は作者スタイルに負けるため、
`render()` が正しく `saved.hidden = true` にしても表示が消えない。
症状は「削除しても消えない」「未設定でも空の行が見える」。

**修正** — `.saved[hidden] { display: none; }` を明示した。

**型・テスト・ビルドがすべて通る種類のバグ**である。`token-form.test.ts` は DOM を触らず、
`main.ts` にはテストが無く、あったとしても jsdom は CSS のカスケードを評価しない。
実機確認が唯一の検出手段だった（発見はユーザー）。

### 修正後の再検証

| Check | Result |
|---|---|
| Type check / Lint / Build / 配線 | Pass |
| Tests | Pass（**112 件**、+5） |
| Coverage | **96.47%** |
| 実機 | 全項目 PASS（差し替え失敗でフルモード維持 / 削除で行ごと消える） |

## orch-review 2 回目と、そこで見つかった構造的欠陥

1 回目の修正版を再レビューしたところ、**前回の修正で作り込んだものではなく
最初から存在していた欠陥**が出た。1 回目は H-4 / H-5 に隠れて見えていなかった。

### H-6（HIGH）: init() の失敗でトークンが URL に平文で載る（修正済み）

`init()` の最初の文が `render(await loadState())` だったため、storage が reject すると
**残りの文（addEventListener 2 つ）に到達しない**。その状態で保存ボタンを押すと:

1. ブラウザのネイティブ GET 送信が起きる
2. `<input type="password" name="token">` の値が**クエリ文字列に平文で載る**
3. manifest はレガシーの `options_page` キーを使うため**フルタブで開く** → アドレスバーと履歴に残る
4. CSP に `form-action` が無いので止まらない

検証エージェントは manifest と CSP まで確認した上で「偽陽性を示すものは無い」と結論した。

**修正**

- `attachListeners()` を `await` より**前**に移した
- `<input>` から **`name` 属性を削除**（name の無いフォームコントロールは送信されない。
  万一ネイティブ送信が起きてもトークンがクエリに載らない保険）
- `init()` の catch で `showMessage()` を呼び、`clearMode()` で嘘の状態を出さない

### A-3（MEDIUM）: 過渡状態で固まる（修正済み）

`submitToken()` が reject すると `render` がスキップされ「確認中」の表示のまま固まっていた。
`showMessage()` を「モード表示に触れない」設計にした副作用。
`restoreMode()` を追加し、実際の保存状態へ戻す（storage も読めなければモード表示を空にする）。

### ファイル分割とテスト（B 案）

`main.ts` はトップレベルで `init()` を実行していたためテストできなかった。
配線を `options-page.ts` に分け、`main.ts` をエントリだけにした。

`options-page.test.ts` を新設し 12 件。**submit イベントを dispatch して `defaultPrevented` を
確認する**ことで「リスナーが付いているか」を直接検証している。
リスナー登録を `await` の後ろに戻すと 4 件が落ちることを確認済み。

## 実機で判明: warn も「エラー」として収集される

無効なトークンを入力したとき、`chrome://extensions` のエラー欄に次が記録されていた。

```
[QTG] api auth rejected: 401 /authenticated_user
```

**計画にもコードのコメントにも「`logger.error` はエラーバッジを立てるので、想定内の失敗は
`logger.warn` を使う」と書いていたが、この前提が誤りだった。**
Chrome は `console.warn` も同じ欄に集める。CLAUDE.md にも同じ誤りが書かれていた。

実害は「ユーザーがトークンを打ち間違えるたびに拡張の不具合として記録される」こと。

**修正** — 401/403 を `logger.debug` に下げた。失敗は UI が伝え、スキャン中の 401 は
scanner の catch が QtgError ごと記録するため重複でもあった。
429 と「応答に想定外の要素」の warn は維持（設計どおりなら起きない異常のため）。

テストを 4 件追加し、**401/403 で warn・error が呼ばれないこと**と
**どのログにもトークンを渡さないこと**を固定した。`warn` に戻すと 2 件落ちる。

CLAUDE.md の設計上の約束 4 も訂正した。

### 最終検証

| Check | Result |
|---|---|
| Type check / Lint / Build / 配線 | Pass |
| Tests | Pass（**128 件** / 9 ファイル） |
| 実機 | 全項目 PASS（保存・削除・無効トークン・エラー欄に記録されないこと） |

## 未完了

- [x] `/code-review` / `/security-review` / `orch-review` によるレビュー（blocking 2 件を修正）
- [ ] コミット

## Next Steps

- [ ] 実機確認（上記）
- [ ] Phase 5（検出エンジン）— Phase 3 と 4 が揃うと着手できる。ここで **OQ-12**（ライトモードの射程で一次証拠のクラスタを捕まえられるか）を検証する

---

*Generated: 2026-08-19*
*Plan: `.claude/PRPs/plans/completed/token-settings-ui.plan.md`*
*Source PRD: `.claude/PRPs/prds/qiita-trend-guard.prd.md` — Phase 3*
