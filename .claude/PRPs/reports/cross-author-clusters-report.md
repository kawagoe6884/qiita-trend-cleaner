# Implementation Report: 著者をまたぐ共起（Phase 5b-2）

## Summary

**記事 1 本の著者を検出できるようにした。** 「別々の著者の記事に、同じ N 人が揃う」を判定軸として追加し、既存の著者内クラスタと**著者ごとにマージ**する。あわせて過去記事を取りに行く前に `created_at` で絞り、**87% の無駄な取得**をやめた（OQ-19）。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | **Medium**（想定どおり） |
| Confidence | 8 / 10 | **達成**。読み切れていなかった「マージ後の burstScore の分母」は、`ClusterHit` を合成してから 1 度だけ計算する形で解決 |
| Files Changed | 12（新規 2 / 更新 10） | **13**（新規 2 / 更新 11） |
| 追加テスト | 14 項目 | **28 項目** |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | 取りに行く前に絞る（OQ-19） | ✅ | `isWithinRetention` を `like-index.ts` に。`scanAuthor` に `now` を引き回した |
| 2 | 著者をまたぐ共起の判定 | ✅ | `cross-cluster.ts`（113 行 / 15 テスト） |
| 3 | 2 つの判定を束ねる | ✅ | `mergeHitsByAuthor` / `buildCoAuthors` |
| 4 | `coAuthors` を型と UI に通す | ✅ | 行ごと出さない形（空の `<p>` を残さない） |
| 5 | 実機確認 | ⏳ **未実施** | 下記チェックリスト |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | ✅ | tsc 0 / eslint 0 / prettier 適用済み |
| Unit Tests | ✅ | **383 通過**（+29）。Statements 97.31% / Branches 91.84% |
| Build | ✅ | `dist/` の配線を確認（sw と content script が別チャンク） |
| Integration | N/A | 拡張機能のため該当なし |
| Edge Cases | ✅ | 空・境界・3 著者・顔ぶれ違い・パース不能な日付 |
| **変異テスト** | ✅ | **7 項目すべてで狙ったテストが落ちた**（1 件はテスト追加後） |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `src/detect/cross-cluster.ts` | **CREATED** | +113 |
| `src/detect/cross-cluster.test.ts` | **CREATED** | +216 |
| `src/detect/detector.ts` | UPDATED | +62 / −10 |
| `src/detect/detector.test.ts` | UPDATED | +90 |
| `src/background/scanner.ts` | UPDATED | +14 / −4 |
| `src/background/scanner.test.ts` | UPDATED | +60 / −5 |
| `src/types/domain.ts` | UPDATED | +18 |
| `src/detect/like-index.ts` | UPDATED | +16 |
| `src/ui/popup/popup-state.ts` | UPDATED | +14 |
| `src/ui/popup/popup-page.ts` | UPDATED | +13 |
| `src/ui/popup/popup-page.test.ts` | UPDATED | +56 |
| `src/ui/popup/index.html` | UPDATED | +5 |

## Deviations from Plan

**1 件。** 計画では `like-index.test.ts` を更新対象に挙げたが、更新しなかった。

`isWithinRetention` は `scanner.test.ts` の 3 テスト（保持期間外・順序・パース不能）で経路ごと検査している。純粋関数の単体テストを別に置くと、**同じ性質を 2 箇所で守ることになり、片方だけ直して直したつもりになる**（Phase 4b の教訓と同じ形）。変異 6・7 で `scanner.test.ts` 側が落ちることを確認済み。

## Issues Encountered

### 変異テストで「守っていないテスト」が見つかった（2 回目）

`if (x.authorHandle === y.authorHandle) continue;` を消しても、`cross-cluster.test.ts` の「同じ著者の記事だけなら成立しない」は**通り続けた**。

`sharedByAuthor.size < 2` が同じ性質を守っていたためで、著者チェックそのものは**どのテストにも守られていなかった**。落ちたのは `detector.test.ts` の 2 件（別の経路）。

差が出る配置を作って 2 テストを追加した:

```
A の記事 1・2 → X グループがいいね
A の記事 3   → Y グループがいいね
B の記事 4   → Y グループがいいね      ← またぐのは 3-4 のペアだけ
```

著者チェックを外すと A の `sharedItemIds` に記事 1・2 が混ざる（**根拠として無関係な記事をユーザーに見せる**）。既存テストのコメントも「両方のチェックが守っている」と正確に書き直した。

**Phase 5b-1 に続いて 2 回連続で、変異を入れるまで気づけなかった。** 今回も「アサーションが真になる経路が 2 つある」形だった。

## 設計上の判断

### 判定は記事ペアの重なりで見る

「M 本以上いいねした顔ぶれ」を全記事にまたがって数えると、**顔ぶれが違っても人数だけ揃ってしまう**（記事 X に 5 人、記事 Y に別の 5 人）。ペアの重なりを直接見れば「同じ人が両方に現れた」ことが保証される。

実測（2026-08-24）の 528 ペアでは、重なり 5 以上が 3 組・4 位以下は 3。**閾値 5 で正常な記事ペアは 1 組も引っかからない。**

### `sharedItemIds` には自分の記事だけ

`popup-state.ts` が根拠 URL を `authorHandle` から組み立てる:

```ts
url: `https://qiita.com/${candidate.authorHandle}/items/${itemId}`
```

他著者の記事 ID を混ぜると**誤った記事をユーザーに見せる**。適合率を測る UI で誤った根拠を出すのは、指標そのものを壊す。他の著者は `coAuthors?` で示す。

### 候補は著者ごとに 1 件

`FeedbackLog` は `Record<AccountHandle, Verdict>`。候補が 2 つ並ぶと同じ著者に 2 回「妥当 / 誤り」を押させることになり、**適合率の分母が壊れる**。実測では著者 B が著者内・著者間の両方で成立していた。

`burstScore` / `emptyAccountRatio` は**マージ後に 1 度だけ**計算する。判定ごとに出して平均を取ると分母が変わる。

### `sharedItemCount` の意味が判定によって変わる

著者内では「その著者の記事のうち M 本」、著者間では **1 本でもよい**。記事 1 本の著者を捕まえるための判定なので、記事の本数はクラスタ全体で満たせばよい。`domain.ts` のコメントに明記した。

### `findCrossAuthorClusters` は 1 クラスタしか返さない

成立したペアの和集合を 1 つのクラスタとして扱う。**独立した組織が同時に検出されたら混ざる。**実測では 1 クラスタだったので、分離が必要になってから作る。`detector.ts` の `buildCoAuthors` にこの制約を書いた。

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `cross-cluster.test.ts` | **15** | 本題 / 二重検出 / 境界 3 種 / 顔ぶれ違い / 根拠 URL / 3 著者 / 空 / **著者チェック 2 件** |
| `detector.test.ts` | +7 | 記事 1 本の著者 / **マージ** / 和集合 / `coAuthors` 3 件 / 顔ぶれ違い |
| `scanner.test.ts` | +3 | 保持期間外 / **順序** / パース不能な日付 |
| `popup-page.test.ts` | +4 | 行を出す / 出さない ×2 / **XSS** |

### 変異テストの結果

| 壊した箇所 | 落ちたテスト |
|---|---|
| 著者チェックを外す | **4 件**（テスト追加後。追加前は 2 件で、どれも別経路だった） |
| 重なりの人数を見ない | 4 件 |
| 境界 `>=` → `>` | 10 件 |
| `sharedItemIds` に両方の記事を入れる | 5 件 |
| マージをやめて別々の候補にする | 3 件 |
| 保持期間のフィルタを外す | 2 件 |
| フィルタと `slice` の順序を入れ替える | 1 件 |

## 記事化の素材

- **「テストが通る」と「テストが守っている」は別。** 著者チェックを外しても既存テストは通り続けた。別のチェック（`size < 2`）が同じ性質を守っていたため。**アサーションが真になる経路が 2 つあると、狙った経路は検査できていない。**Phase 5b-1 に続いて 2 回連続で同じ形だった
- **UI の実装詳細が、検出エンジンの設計を決めた。** 根拠 URL を `authorHandle` から組み立てているという 1 行が、「`sharedItemIds` に他著者の記事を混ぜない」という判定側の制約になった。**層を分けても、データの意味は層を越えて伝播する**
- **評価の単位が候補の単位を決めた。** `FeedbackLog` が著者ごとなので、候補も著者ごとにまとめざるを得ない。**指標の形が、その手前の設計を拘束する**
- **取りに行く前に捨てれば、捨てる必要がなくなる。** 45 req 使って 6 本しか残らなかったのは、取得と保存が別々の基準で動いていたため。同じ基準を取得側にも置くだけで消えた

## Manual Validation（未実施 — ユーザーが実機で確認）

- [ ] `dist/` を未パック拡張として読み込み直す
- [ ] トークンありでトレンドを開く
- [ ] **`fetched:` が大幅に減っている**（前回 45。一桁を期待）
- [ ] **`purged:` も減っている**（前回 427）
- [ ] **候補が 2 件になる**（記事 1 本の著者が出る）
- [ ] 候補に「同じ顔ぶれが〈他の著者〉の記事にも現れています」が出る
- [ ] **同じ著者が 2 回出ていない**（マージが効いている）
- [ ] 根拠リンクが正しい記事を開く（**他著者の記事 ID で URL が組まれていない**）
- [ ] 「妥当 / 誤り」を押すと適合率が更新される
- [ ] `chrome://extensions` のエラー欄が空のまま

## Next Steps

- [ ] **実機確認**（上記）— これが通るまで Phase 5b-2 は complete にしない
- [ ] コミット
- [ ] **適合率を測る** — 候補が増えるので、押す対象も増える。**閾値を動かす前にフィードバックを貯める**
- [ ] Phase 7（DOM 非表示）— 候補が出るようになったので、隠す対象ができた

---

## レビュー指摘への対応（2026-08-24）

`/ecc:orch-review` の結果は **CHANGES_REQUESTED**（blocking HIGH 2 件 / advisory MEDIUM 1 件）。すべて対応した。

### HIGH — 独立した組織の顔ぶれが混ざっていた

`cluster` が**全ペアで共有される単一の Set** だった。独立した 2 つの組織が同時に成立すると、互いの顔ぶれが混ざる。

| 影響 | 内容 |
|---|---|
| **UI が事実でないことを述べる** | 重なりゼロの著者について「同じ顔ぶれが〈その著者〉の記事にも現れています」 |
| `clusterSize` | 5 → 10 に膨張（**並び順の主キー**） |
| `emptyAccountRatio` | 1.0 → 0.5 に希釈（レビュアーの実行値） |
| `minSharedItems` | 別の組織の記事で本数を満たしてしまう |

**これは私が書いて放置した制約だった。** `detector.ts` に「独立した組織が同時に検出された場合は混ざるが、実測では 1 クラスタだった。分離が必要になったら cross-cluster.ts 側でクラスタを分ける」と書いていた。**書いただけで直していなかった。**

**修正**: 著者をノード・成立したペアを辺とするグラフの**連結成分**（Union-Find、経路圧縮つき・非再帰）ごとに `clusterAccounts` / `coAuthors` / 記事本数を集計する。`detector.ts` の `buildCoAuthors` は削除し、`CrossClusterHit.coAuthors` をそのまま使う。

**テスト 9 件を追加**（`cross-cluster.test.ts` 5 / `detector.test.ts` 4）。実装当時のテストは**すべて 1 つの連結クリーク**しか作っておらず、この経路を 1 度も通っていなかった。

修正前の挙動に戻す変異（全ペアを 1 成分にまとめる）で **6 件が落ちる**ことを確認。

### MEDIUM — `isWithinRetention` に直接の単体テストが無い

計画から意図的に外していた（「同じ性質を 2 箇所で守ると片方だけ直して直したつもりになる」）。だが**境界は経路のテストでは読めない**ので、役割を分けて追加した。

- `scanner.test.ts` — **経路**（取りに行かない / 絞ってから件数で切る）
- `like-index.test.ts` — **境界**（0 日 / 6 日 / **7 日ちょうど** / 8 日 / パース不能 / 空文字）

特に「**`purgeLikeIndex` と同じ境界を使う**」テストを置いた。取得側と保存側の境界がずれると「取ったのに保存されない」隙間が 1 日ぶんできる。境界を `>=` から `>` に変える変異で 2 件が落ちる。

### 対応後の検証

```
399 tests（+16）/ tsc 0 / eslint 0 / prettier / build すべて PASS
Statements 97.27% / Branches 91.57%
変異 9 項目すべてで狙ったテストが落ちる
```

### この指摘が示したこと（記事の素材）

- **「実測ではこうだった」は、コードが正しいことの証明にはならない。** 1 クラスタしか観測していないことと、2 クラスタで壊れないことは別の話。**観測の範囲を実装の保証にすり替えていた**
- **「制約を記録した」で 2 回目の打ち切り。** Phase 6 の `currentRateLimited` と同じ形。**書くことで安心し、直す判断を先送りした**
- **レビュアーは実際にコードを走らせて確認していた。** 一時テストを作成 → 実行 → 削除し、`burstScore` への影響については**自分の主張を一部撤回**している。「動かして確かめる」と「一部を撤回する」の両方が揃って初めて、指摘が信頼できる
