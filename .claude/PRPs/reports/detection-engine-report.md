# Implementation Report: 検出エンジン（Phase 5）

## Summary

蓄積した逆引きインデックスから共起クラスタを検出する層を `src/detect/` に新設した。判定は純粋関数だけで構成し、storage への保存とログ出力は `scanner.ts` の責務に留めた。

`scanner.ts` の `likeIndex` 上書き保存をマージ + パージに変え、複数のトレンドセットにまたがる蓄積を可能にした。検出結果は `storage.local` の `candidates` に保存し、`logger.info` にも出す（Phase 6 の UI ができるまでの唯一の確認手段、かつ OQ-12 の検証手段）。

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large（想定どおり） |
| Confidence | 8/10 | 妥当。実装で迷う場面は無かった |
| Files Changed | 新規 8 / 変更 4 | 新規 8 / 変更 4（一致） |
| 新規テスト | — | 55 件（149 → 204） |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | `Candidate` 型の拡張 | 完了 | `sharedItemIds` / `emptyAccountRatio` を追加 |
| 2 | `detect/like-index.ts` | 完了 | |
| 3 | `detect/like-index.test.ts` | 完了 | 16 件 |
| 4 | `detect/cluster.ts` | 完了 | |
| 5 | `detect/cluster.test.ts` | 完了 | 9 件 |
| 6 | `detect/burst.ts` | 完了 | |
| 7 | `detect/burst.test.ts` | 完了 | 15 件 |
| 8 | `detect/detector.ts` | 完了 | |
| 9 | `detect/detector.test.ts` | 完了 | 9 件 |
| 10 | `lib/storage.ts` の候補アクセサ | 完了 | |
| 11 | `background/scanner.ts` への配線 | 完了 | **逸脱あり** — 下記 |
| 12 | `background/scanner.test.ts` の統合テスト | 完了 | 6 件 |
| 13 | 全体検証 | 完了 | |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis (tsc) | Pass | エラー 0 |
| Lint (eslint) | Pass | 警告・エラー 0 |
| Unit Tests | Pass | 204 件（+55） |
| Build | Pass | `✓ built in 65ms` |
| dist 配線 | Pass | SW / CS ローダーが別々の正しいチャンクを指す |
| Coverage | Pass | Statements 97.22% / Branches 89.84% |
| Edge Cases | Pass | 空・境界・壊れた日時・ゼロ除算をすべて網羅 |

`src/detect/` の Statements は **100%**。

## Files Changed

| File | Action | Lines |
|---|---|---|
| `src/detect/like-index.ts` | CREATED | +141 |
| `src/detect/like-index.test.ts` | CREATED | +185 |
| `src/detect/cluster.ts` | CREATED | +114 |
| `src/detect/cluster.test.ts` | CREATED | +174 |
| `src/detect/burst.ts` | CREATED | +91 |
| `src/detect/burst.test.ts` | CREATED | +175 |
| `src/detect/detector.ts` | CREATED | +40 |
| `src/detect/detector.test.ts` | CREATED | +149 |
| `src/background/scanner.ts` | UPDATED | +78 / -6 |
| `src/background/scanner.test.ts` | UPDATED | +86 / -1 |
| `src/lib/storage.ts` | UPDATED | +17 |
| `src/types/domain.ts` | UPDATED | +13 / -2 |

合計 **+1256 / -7**。

## Deviations from Plan

### 1. `persistScan` にインライン展開せず `persistIndexAndDetect` に切り出した

- **WHAT**: 計画では `persistScan` の中にマージ・パージ・検出を直接書く想定だった。実際は `persistIndexAndDetect(fresh)` として独立させ、`persistScan` からは 1 行で呼ぶ形にした
- **WHY**: 計画どおり展開すると `persistScan` が 50 行を超え、code-review の基準（関数 50 行以内）に抵触する。計画自身も「`persistScan` が 50 行を超えないよう、ログは別関数に切る」と書いており、その方針を保存処理にも広げた

### 2. `countFeedSets` を実装しなかった

- **WHAT**: 計画には「distinct な `itemPostedAt` の日付 + 5:00/17:00 区分の数」を返す `countFeedSets` があったが、作らなかった
- **WHY**: 蓄積状況は `records:` と `accounts:` で十分読み取れる。トレンドセット数は `itemPostedAt`（記事の投稿時刻）からは正確に導けない — 記事の投稿時刻とトレンドセットの更新時刻は別物であり、実装すると**それらしいが正しくない数値**をログに出すことになる。YAGNI として落とした

## Issues Encountered

なし。既存パターン（`rate-budget.ts` の純粋関数層、`storage.ts` のフェイルセーフ、`scanner.test.ts` のモック構成）にそのまま乗り、型・lint の修正も発生しなかった。

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `src/detect/like-index.test.ts` | 16 | マージの冪等性・非破壊性、パージの境界、遡及フィルタ、壊れた日時 |
| `src/detect/cluster.test.ts` | 9 | N/M の境界、**手順 4 の絞り込み**、著者ごとの分離、ソート |
| `src/detect/burst.test.ts` | 15 | 窓の境界（60分/61分）、負の Δ、パース失敗、ゼロ除算、空アカウント判定 |
| `src/detect/detector.test.ts` | 9 | **OQ-12 の単体再現**、遡及窓、全フィールド、並び順 |
| `src/background/scanner.test.ts` | +6 | 蓄積・重複排除・候補保存・打ち切り時の挙動・ログ水準 |

### テストがバグを捕まえることの確認

実装を戻して落ちることを確認済み。

| 戻した内容 | 落ちたテスト |
|---|---|
| 蓄積をやめて上書きに戻す | 1 件（2 回スキャンするとインデックスが蓄積される） |
| **手順 4 の絞り込みを外す** | **2 件**（手順 3 は通るが手順 4 で落ちる／揃っている記事だけが sharedItemIds に入る） |
| マージの重複排除を外す | 1 件（同じ記事を 2 回スキャンしても重複しない） |

## OQ-12 は解決（肯定）

**実機の初回スキャンで 5 件検出した。** 拡張を削除して読み込み直した直後、蓄積ゼロの状態である。

```
index merged: accounts: 296 records: 422 purged: 0
detected 5 candidates (N>=5 M>=2 within 3d)
```

| # | cluster | shared | burst | empty |
|---|---|---|---|---|
| a | 16 | 5 | 0.92 | 0.00 |
| b | 15 | 2 | 0.23 | 0.67 |
| c | 8 | 2 | 0.00 | 0.63 |
| d | 6 | 2 | 0.17 | 0.00 |
| e | 5 | 2 | 0.50 | 0.80 |

### 計画の予測が外れた

計画にはこう書いた。

> ライトモードは 1 回のスキャンでは**原理的に発火しない**。トレンド 30 件の中に同一著者の記事が 2 本入ることが稀で、M=2 を満たせないため

**これは誤り。** `shared` の合計は 13 で、5 著者だけでトレンド 30 枠のうち少なくとも 13 を占めていた。著者の重複は稀どころか常態である。蓄積の実装は射程を広げる意味で有効だが、「蓄積しないと動かない」という前提は成立しない。

### 空アカウント率が二極化している

`0.00 / 0.00 / 0.63 / 0.67 / 0.80` で、0.00 と 0.63 の間に何も無い。ノイズなら 0.1〜0.4 に散らばるはずであり、**この指標が実在する何かを測っている**ことを示唆する。PRD が Phase 9 で「空アカウント指標の重み調整」を予定していた賭けは正しかった。

ただし `empty: 0.00` は「シロ」を意味しない。PRD が引用する Togetter の議論は「大学の講義での相互 LGTM」であり、**講義で記事を書いている学生は記事もプロフィールも持つ**。空アカウント指標は手口の片方しか見ていない。

### 適合率はまだ測れない

正解が分からないため、a と d がクロかシロかは判定できない。これを測る手段が Phase 6 のフィードバック UI であり、**測る前に閾値を動かすのは PRD の単一指標設計が避けようとしている失敗**である。現状のまま Phase 6 へ進む。

## 記事化の素材

- **「N 人が M 本に共通」を素直に実装すると誤検知する。** 手順 3 だけでは「別々の集団がそれぞれ 2 本ずつ」を拾う。手順 4 を外すとテストが 2 件落ちることで、この差が実在することを確認した
- **`NaN` は比較をすべて false にするため、「範囲外」と「壊れている」が区別なく落ちる。** `toEpochMs` が `null` を返す形に統一して封じ込めた
- **計画に書いた関数を 1 つ落とした。** `countFeedSets` は「それらしいが正しくない数値」を出すことになると実装中に判明した。記事の投稿時刻からトレンドセットの更新回数は導けない

## Next Steps

- [ ] `/ecc:orch-review` でレビュー
- [ ] コミット
- [ ] **実機で OQ-12 を検証**（数日かけて蓄積し、候補が出るか観測）
- [ ] Phase 6（候補一覧 UI）へ
