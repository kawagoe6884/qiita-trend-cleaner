# Implementation Report: 検出の穴を塞ぐ（Phase 5b-1 — バグ 2 件）

## Summary

2026-08-23 の実機調査で見つかった検出の穴 3 件のうち、**バグ 2 件**を直した。

1. **著者巡回が起動しない** — 著者を `newItems` からしか取らず、トークンを後から設定した人は過去記事を永久に取りに行かなかった
2. **判定窓が過去記事を捨てる** — `withinLookback` が `itemPostedAt` で 3 日に切るため、フルモードで取った過去記事が判定に入らなかった

**著者間共起（欠陥 3 / OQ-18）は 5b-2 に残している。** 記事 1 本の著者は依然として検出できない。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | **Medium**（想定どおり） |
| Confidence | 8 / 10 | **達成**。読み切れていなかった 429 の中断位置は、計画どおり戻り値を変えて解決 |
| Files Changed | 10（新規 2 / 更新 8） | **11**（新規 2 / 更新 9） |
| 追加テスト | 13 項目 | **27 項目** |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | 訪問記録の型を足す | ✅ Complete | `AuthorVisits` / `LocalState.authorVisits` |
| 2 | 既定の窓を 7 日にする | ✅ Complete | `like-index.ts` のコメント 2 箇所も更新 |
| 3 | 巡回対象を決める純粋関数 | ✅ Complete | `author-visits.ts`（106 行 / 16 テスト） |
| 4 | scanner の配線 | ✅ Complete | `scanAuthorHistory` の戻り値を `{ progress, visited }` に変更 |
| 5 | モード案内の文言 | ✅ Complete | 「判定材料が揃いません」を枠の説明より先に |
| 6 | 実機確認 | ⏳ **未実施** | 下記チェックリスト。**これが通るまで complete にしない** |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | ✅ Pass | tsc 0 errors / eslint 0 problems / prettier 適用済み |
| Unit Tests | ✅ Pass | **354 通過**（+27）。Statements 97.2% / Branches 91.22% |
| Build | ✅ Pass | `dist/` の配線を確認（service worker と content script が別チャンク） |
| Integration | N/A | 拡張機能のため該当なし |
| Edge Cases | ✅ Pass | 空入力・壊れた保存値・境界（23h/24h/25h、6d/7d/8d）・重複・中断 |
| **変異テスト** | ✅ Pass | **6 項目すべてで狙ったテストが落ちた**（1 件は修正後） |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `src/background/author-visits.ts` | **CREATED** | +106 |
| `src/background/author-visits.test.ts` | **CREATED** | +147 |
| `src/background/scanner.ts` | UPDATED | +52 / −10 |
| `src/background/scanner.test.ts` | UPDATED | +65 / −2 |
| `src/types/domain.ts` | UPDATED | +25 / −1 |
| `src/lib/storage.ts` | UPDATED | +23 |
| `src/lib/storage.test.ts` | UPDATED | +46 |
| `src/detect/detector.test.ts` | UPDATED | +19 / −2 |
| `src/detect/like-index.ts` | UPDATED | +10 / −2 |
| `src/dom/selectors.test.ts` | UPDATED | +4 / −1 |
| `src/ui/popup/popup-state.ts` | UPDATED | +4 / −1 |

## Deviations from Plan

**1 件。** 計画に無かった `src/lib/storage.test.ts` の追加（+46 行 / 6 テスト）。

計画の Files to Change には挙げていたが、Testing Strategy の表には「壊れた `authorVisits` は `{}` に倒す」の 1 行しか無かった。実際には**壊れ方が 5 通り**ある（オブジェクトでない / 配列 / 1 件だけ壊れている / 空文字 / 未保存）ため、それぞれを固定した。

## Issues Encountered

### 変異テストが 1 件を捕まえなかった

「429 中でも訪問記録を書く」変異を入れても、全テストが通ってしまった。

原因は**テストが弱かった**こと:

```ts
// 弱い版
await runScan(TWO_ITEMS);   // 1 人目で 429
vi.clearAllMocks();
await runScan(TWO_ITEMS);
expect(itemsMock).toHaveBeenCalled();   // ← 2 人目が未訪問なので必ず通る
```

1 人目が誤って記録されても、**2 人目が未訪問のまま残る**ので `toHaveBeenCalled()` が成立する。

2 つに割って直した:

- 「429 のあと訪問記録が**空**であること」（`getAuthorVisits()` を直接見る）
- 「次のスキャンで **2 人とも**辿ること」（`toHaveBeenCalledTimes(2)`）

**CLAUDE.md の教訓がそのまま当たった** — 「テストを書いたら、直した箇所を戻して落ちることを必ず確認する」。変異を入れていなければ、この穴は実機でも見えないまま残った（429 は普段起きないため）。

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `author-visits.test.ts` | **16** | 未訪問 / 境界 3 種 / 重複 / パース不能 / 空 / 対象外 / 非破壊 / prune 4 種 |
| `scanner.test.ts` | +5 | **トークン後付けで巡回が走る**（欠陥 1 の番人）/ 24 時間の再訪 / 429 で記録しない ×2 / ライトでは記録しない |
| `storage.test.ts` | +6 | 壊れた値のフォールバック 5 種 + 往復 |
| `detector.test.ts` | +1 | **6 日前の記事は判定に入る**（欠陥 2 の番人） |

### 変異テストの結果

| 壊した箇所 | 落ちたテスト |
|---|---|
| 著者を `items` → `newItems` に戻す | **3 件** |
| 再訪の境界 `<=` → `<` | 1 件 |
| `recordVisits` を破壊的更新に | 1 件 |
| `DEFAULT_SETTINGS.lookbackDays` 7 → 3 | 2 件 |
| 429 中でも訪問記録を書く | **2 件**（テスト強化後） |
| `getAuthorVisits` の検証を外す | 2 件 |

## 設計上の判断

### 429 以外の失敗は「訪問済み」にする

`scanAuthor` は 429 以外の失敗（存在しない著者・非公開アカウント）を握りつぶして `logger.debug` に留める。呼び出し側から成否は見えない。

**見えないまま「訪問済み」にした。** 毎回叩き直すより 24 時間待つ方が枠に優しく、失敗が一時的なら次の再訪で拾える。`AuthorScanResult.visited` のコメントに理由を書いた。

### 時刻は `startedAt` から作る

`scanTrend` で `new Date(startedAt)` を 1 度だけ作り、訪問記録に使い回す。スキャン中に日付が変わっても、「このスキャンで辿った」ことを 1 つの時刻で表せる。

**純粋層（`author-visits.ts`）は `now` を引数で受ける。** 関数内で `new Date()` を呼ぶ設計にすると、2026-08-23 に起きた「日付が変わっただけでテストが 3 件落ちる」が再発する。

### 訪問記録も purge する

`persistIndexAndDetect` で `pruneVisits` を呼ぶ。記録だけが残ると、保持期間を過ぎてインデックスから消えた著者を「訪問済み」として飛ばし続ける。**件数が変わったときだけ保存する**（無駄な書き込みを避ける）。

## 記事化の素材

- **修正の方向を決めるとき、反対側の端を見ていなかった。** 「リロードで 30 req 使う」を直した結果「トークンを設定しても 1 req も使わない」になった。同じ関数で、前回は叩きすぎ、今回は叩かなすぎ。**今回は「叩く」「叩かない」の両方をテストで固定した**
- **弱いテストは、変異を入れるまで弱いと分からない。** 「429 で記録しない」テストは、2 人目が未訪問のまま残るせいで必ず通っていた。**アサーションが真になる経路が 2 つあると、狙った経路を検査できていない**
- **「その著者を訪れたか」は記事 ID からは判定できない。** 記事が 1 本しか無い著者と、まだ辿っていない著者が同じ見え方になる。**状態を持たずに済ませようとして、持つべき状態を記事集合から推測していた**
- **取得の射程と判定の窓は、同じ人が同時に決めないとずれる。** 過去記事を取りに行く機能（Phase 4b）と、直近 3 日で切る判定（Phase 5）は別々に作られ、噛み合わないまま両方が「正しく動いて」いた

## Manual Validation（未実施 — ユーザーが実機で確認）

- [ ] `dist/` を未パック拡張として読み込み直す
- [ ] **トークンを設定した状態でトレンドを開く** → ログに `fetched:` が 0 でない数字
- [ ] **同じページをすぐリロード** → `fetched: 0`（24 時間以内なので巡回しない）
- [ ] ポップアップの「遡る日数」が **7**（新規インストール時。**既存の設定は変わらない**）
- [ ] ライトモード（トークンを消す）の案内に「判定材料が揃いません」が出る
- [ ] **`chrome://extensions` のエラー欄が空のまま**
- [ ] 調査で使った 2 著者のうち、**記事が複数ある方が候補に出る**
- [ ] 記事 1 本の方は**出ない**（5b-2 の担当。ここで出たら想定と違うので調べ直す）

## Next Steps

- [ ] **実機確認**（上記）— これが通るまで Phase 5b-1 は complete にしない
- [ ] コミット
- [ ] **数日ぶんのデータを貯める** — フルモードが初めて正常に動くので、`重なり 5 以上` のペアが何組出るかを毎日測る
- [ ] Phase 5b-2（著者をまたぐ共起）の計画 — 閾値はそのデータで決める
- [ ] 候補が出たら「妥当 / 誤り」を押す — **適合率の入力はこれしかない**

---

## 実機確認の結果（2026-08-24）

### 通った

```
1 回目  trend items: 27 new: 0 mode=full
        index merged: accounts: 198 records: 270 purged: 427
        detected 1 candidates (accounts>=5 items>=2 within 7d)
          candidate: cluster: 18 shared: 2 burst: 0.97 empty: 0.17
        scan finished: fetched: 45 likes: 462 rate-remaining: 928

2 回目  scan finished: fetched: 0 likes: 0 rate-remaining: unknown
```

| 確認項目 | 結果 |
|---|---|
| **`new: 0` でも著者を辿る** | ✅ `fetched: 45`（**以前はここが 0**。欠陥 1 が直った） |
| **リロードでは叩かない** | ✅ `fetched: 0`（訪問記録が効いている） |
| **判定窓が 7 日** | ✅ `within 7d` |
| **記事が複数ある著者が候補に出る** | ✅ `cluster: 18`（調査時の `qualifying: 18` と一致） |
| **記事 1 本の著者は出ない** | ✅ 想定どおり（5b-2 の担当） |
| エラー欄 | ✅ 空のまま |
| 遡る日数の既定が 7 | ⚠️ **未確認** — ユーザーが既に 7 にしていたため。新規インストール時の値は `selectors.test.ts` が担保 |
| ライトモードの案内 | ⚠️ **未確認** — トークンを消す必要があり、実施していない |

**`burst: 0.97` は調査で測っていなかった数字。** 投稿から 60 分以内のいいねが 97%。`empty: 0.17` はインデックス全体の 38% より低く、「空アカウント指標はこの手口を素通りする」という調査の結論と整合する。

### 新しく見つかったこと — 保存の窓も同じことをしていた

```
index merged: accounts: 198 records: 270 purged: 427
```

**462 件のいいねを取得して、merge 後 697 件のうち 427 件（61%）が保存前に捨てられた。**

`purgeLikeIndex` も `withinLookback` と同じく **`itemPostedAt`** で切る。`MAX_EXTRA_ITEMS_PER_AUTHOR` は「最新の**未取得** 2 本」を取るが、著者が毎日書いていなければ `RETENTION_DAYS = 7` より古くなる。

**判定の窓は直したが、保存の窓が同じことをしていた。** 窓は 3 つある:

| 窓 | どこ | 基準 | 状態 |
|---|---|---|---|
| 取得の射程 | `MAX_EXTRA_ITEMS_PER_AUTHOR` | 件数（2 本） | 時刻を見ていない |
| 判定の窓 | `withinLookback` | `itemPostedAt` × `lookbackDays` | ✅ 5b-1 で 7 日に |
| **保存の窓** | `purgeLikeIndex` | `itemPostedAt` × `RETENTION_DAYS` | **未対応** |

**対応は 5b-2 に送る**（ユーザー判断）。`RETENTION_DAYS` の変更は PRD の法務判断に由来するので触らず、**取りに行く前に `created_at` で絞る**方向で検討する。認証枠は 1000 req/h あり、今回の消費は 72 req なので実害は小さい。OQ-19 として記録した。
