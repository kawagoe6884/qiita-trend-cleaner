# Plan: 著者をまたぐ共起（Phase 5b-2）

## Summary

**記事 1 本の著者を捕まえる。** 現在の判定は「同じ著者の M 本に同じ顔ぶれが揃う」なので、記事が 1 本しかない著者は原理的に検出できない。「**別々の著者の記事に、同じ N 人が揃う**」を判定軸として追加する。あわせて、取りに行く前に `created_at` で絞り、**87% の無駄な取得**をやめる（OQ-19）。

## User Story

As a トレンドを健全化したいユーザー,
I want 1 本しか記事を出していない著者でも、不自然ないいねパターンなら候補に出ること,
So that 組織ぐるみの相互いいねを取りこぼさない.

## Problem → Solution

| | 現状 | 後 |
|---|---|---|
| 判定単位 | 著者ごとに閉じている | **著者をまたぐ共起**を追加。既存の著者内判定は残す |
| 記事 1 本の著者 | 手順 1 で即 `null`。**閾値でも射程でも届かない** | 別の著者の記事と合わせて M 本を満たせば候補になる |
| 過去記事の取得 | 直近 2 本を無条件に取る。**45 req 使って 6 本しか残らない** | `created_at` で絞ってから取る |

## Metadata

- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/qiita-trend-cleaner.prd.md`
- **PRD Phase**: Phase 5b-2（OQ-18 + OQ-19）
- **調査**: [cross-author-collusion-investigation.md](../reports/cross-author-collusion-investigation.md)
- **Estimated Files**: 12（新規 2 / 更新 10）

---

## 実データ（2026-08-24 実測・これが設計の根拠）

33 記事・528 ペアの、いいね者集合の重なり:

| 順位 | 重なり | 率 | 同一著者 | 既存判定で拾えるか |
|---|---|---|---|---|
| 1 | **17** | 0.65 | false | ❌ |
| 2 | **15** | 0.68 | **true** | ✅ 拾えている |
| 3 | **15** | 0.68 | false | ❌ |
| 4 位以下 | **3 以下** | — | — | — |

- **528 ペア中、重なり 5 以上は 3 組だけ。** 3 位と 4 位の差は 15 対 3（5 倍）
- **閾値 5 で誤検知ゼロ。** 正常な記事ペアは 1 組も引っかからない
- **同じ 15〜18 人のグループが 3 通りの現れ方をしている**（A↔B / B↔B の過去記事 / A↔B の過去記事）

### 取得の無駄（OQ-19）

```
fetched: 45  →  保存された記事は 6 本（13%）
purged: 427（merge 後 697 件のうち 61%）
```

`MAX_EXTRA_ITEMS_PER_AUTHOR` が「最新の**未取得** 2 本」を取るが、**トレンドに出る著者でも直近 2 本が 7 日以内とは限らない**。取ってから捨てている。

---

## 決定事項（この計画の前提）

### 1. 候補の単位は「著者ごと」。判定が 2 本でも候補は 1 つにまとめる

実測では、著者 B が**著者内クラスタと著者間クラスタの両方で成立**する。別々に候補を作ると B が 2 回出る。

**`FeedbackLog` は `Record<AccountHandle, Verdict>` で、評価は著者ごとに 1 つ。**候補が 2 つあると、同じ著者に 2 回「妥当 / 誤り」を押させることになり、適合率の分母が壊れる。

→ 両方の判定を走らせ、**著者ごとにマージ**する。

### 2. `sharedItemIds` には自分の記事だけを入れる

`toViews` が根拠 URL を組み立てている:

```ts
// SOURCE: src/ui/popup/popup-state.ts:76-79
evidence: candidate.sharedItemIds.map((itemId) => ({
  itemId,
  url: `https://qiita.com/${candidate.authorHandle}/items/${itemId}`,
})),
```

**他著者の記事 ID を混ぜると URL が壊れる**（A の記事 ID を B のハンドルで組み立てる）。`sharedItemIds` の意味を変えず、他著者は `coAuthors` で示す。

### 3. `Candidate` に `coAuthors?: AccountHandle[]` を optional で足す

既存コード（Phase 6 の一覧・Phase 7 の非表示）は無視できる。UI だけが読む。**型の破壊的変更を避ける。**

### 4. `sharedItemCount` の意味が判定によって変わることを受け入れる

著者内クラスタでは「その著者の記事のうち M 本」。著者間クラスタでは **1 本でもよい**（A は記事が 1 本しかない）。`minSharedItems` はクラスタ全体で満たせばよく、著者ごとには課さない。

**この非対称は記録しておく。** Phase 9 で閾値を触る人が「なぜ 1 本で候補になっているのか」を追えるように。

### 5. 閾値は既存の `minClusterSize` / `minSharedItems` を流用する

実データで閾値 5 なら 3 組・誤検知ゼロ。**スライダーを 4 本目にしない。** Phase 9 で調整する軸を増やすと、適合率が動いた原因の切り分けが難しくなる。

---

## UX Design

### Before

```
┌────────────────────────────────────┐
│ 候補 1 件 / 適合率 100%（1 件）     │
│                                    │
│ ▸ 著者B                            │
│   18 アカウントが 2 記事に共通      │
│   根拠: [記事1] [記事2]            │
│   [妥当] [誤り]                    │
└────────────────────────────────────┘
   ↑ 同じ組織の著者A（記事 1 本）は出ない
```

### After

```
┌────────────────────────────────────┐
│ 候補 2 件 / 適合率 100%（1 件）     │
│                                    │
│ ▸ 著者B                            │
│   18 アカウントが 2 記事に共通      │
│   同じ顔ぶれが 著者A の記事にも     │
│   根拠: [記事1] [記事2]            │
│   [妥当] [誤り]                    │
│                                    │
│ ▸ 著者A                            │
│   17 アカウントが 1 記事に共通      │
│   同じ顔ぶれが 著者B の記事にも     │
│   根拠: [記事1]                    │
│   [妥当] [誤り]                    │
└────────────────────────────────────┘
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 候補一覧 | 著者内クラスタのみ | 著者間クラスタも | **著者ごとに 1 件**（両方成立してもマージ） |
| 根拠リンク | その著者の記事 | 変わらず | `sharedItemIds` の意味を変えないため |
| 新しい行 | なし | 「同じ顔ぶれが〈他の著者〉の記事にも」 | `coAuthors` があるときだけ表示 |
| **断定しない**（約束 6） | 「不自然ないいねパターン」 | 変わらず | 「組織票」「不正」とは書かない |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| **P0** | `src/detect/cluster.ts` | all（113 行） | 既存の判定。**新しい判定はこの隣に置く** |
| **P0** | `src/detect/detector.ts` | all（40 行） | 2 つの判定を束ねる場所 |
| **P0** | `src/background/scanner.ts` | 185-200 | `scanAuthor` の `extras` 生成。**ここが OQ-19** |
| P1 | `src/types/domain.ts` | 63-90 | `Candidate`。`coAuthors?` を足す |
| P1 | `src/detect/burst.ts` | 30-95 | `burstScore` / `emptyAccountRatio` は `ClusterHit` を受ける。**再利用できる** |
| P1 | `src/ui/popup/popup-state.ts` | 72-81 | `toViews`。**根拠 URL の組み立て** |
| P2 | `src/detect/cluster.test.ts` | all | 「手順 3 は通るが手順 4 で落ちる」の書き方 |
| P2 | `src/background/author-visits.ts` | all | 純粋層の書き方（`now` を引数で受ける） |

## External Documentation

**不要。** すべて内部パターンで完結する。

---

## Patterns to Mirror

### 判定は純粋関数・storage を触らない
```ts
// SOURCE: src/detect/cluster.ts:1-6
/**
 * 共起クラスタの判定。プロダクトの中核。
 * この層は純粋関数だけで構成する（storage も fetch も触らない）。
 */
```

### ClusterHit を返す形（burst / empty が再利用できる）
```ts
// SOURCE: src/detect/cluster.ts:26-33
export interface ClusterHit {
  authorHandle: AccountHandle;
  /** 昇順。表示順とテストを安定させるため */
  clusterAccounts: AccountHandle[];
  /** 昇順。クラスタが N 人そろって現れた記事 */
  sharedItemIds: ItemId[];
}
```
**新しい判定も `ClusterHit` を返す。** そうすれば `burstScore(index, hit)` と `emptyAccountRatio(index, hit.clusterAccounts)` をそのまま使える。

### 2 段階で絞る（誤検知の入口を塞ぐ）
```ts
// SOURCE: src/detect/cluster.ts:80-95
// 手順 2-3: 「A の記事を M 本以上いいねしている顔ぶれ」
const qualifying = new Set<AccountHandle>();
for (const [account, items] of view.itemsByAccount) {
  if (items.size >= settings.minSharedItems) qualifying.add(account);
}
if (qualifying.size < settings.minClusterSize) return null;

// 手順 4: 「その顔ぶれが N 人そろって現れた記事」
// ここが誤検知との分かれ目。手順 3 だけで候補にしてはいけない
```

### ソートは決定的に
```ts
// SOURCE: src/detect/cluster.ts:98-101
clusterAccounts: [...qualifying].sort(),
sharedItemIds: sharedItemIds.sort(),
```

### 定数に根拠を書いて export
```ts
// SOURCE: src/detect/burst.ts:22-25
export const BURST_WINDOW_MINUTES = 60;
export const EMPTY_MAX_FOLLOWERS = 5;
```

### テストは合成値のみ
```ts
// SOURCE: src/background/author-visits.test.ts:15
/** 合成のインデックス。実アカウント名・実 item_id は使わない */
```
**`example-author-N` 形式。実アカウント名は絶対に書かない**（CLAUDE.md の絶対制約）。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/detect/cross-cluster.ts` | **CREATE** | 著者をまたぐ共起の判定 |
| `src/detect/cross-cluster.test.ts` | **CREATE** | |
| `src/detect/detector.ts` | UPDATE | 2 つの判定を束ね、**著者ごとにマージ** |
| `src/detect/detector.test.ts` | UPDATE | マージの検査 |
| `src/types/domain.ts` | UPDATE | `Candidate.coAuthors?` |
| `src/background/scanner.ts` | UPDATE | `extras` を `created_at` で絞る（OQ-19） |
| `src/background/scanner.test.ts` | UPDATE | 古い記事を取りに行かないこと |
| `src/detect/like-index.ts` | UPDATE | 保持期間内かを判定する関数を export（scanner が使う） |
| `src/detect/like-index.test.ts` | UPDATE | |
| `src/ui/popup/popup-state.ts` | UPDATE | `coAuthors` の文言 |
| `src/ui/popup/popup-page.ts` | UPDATE | `coAuthors` の行を描画 |
| `src/ui/popup/popup-page.test.ts` | UPDATE | |

## NOT Building

- **押した側（クラスタのアカウント群）を候補にする** — ミュートしても記事は消えない。候補は受益者（著者）だけ
- **`Candidate.sharedItemIds` の型変更** — 根拠 URL の組み立てが壊れる。他著者は `coAuthors` で示す
- **4 本目のスライダー** — 閾値は既存を流用する
- **`RETENTION_DAYS` の変更** — 法務判断に由来する値。触らない
- **`MAX_EXTRA_ITEMS_PER_AUTHOR` の増加** — OQ-19 を直して枠が空いてから、実データを見て決める
- **クラスタ単位の新しい型** — `FeedbackLog` が著者ごとなので、候補も著者ごとに保つ

---

## Step-by-Step Tasks

### Task 1: 取りに行く前に絞る（OQ-19）

- **ACTION**: `like-index.ts` に「保持期間内か」を判定する関数を足し、`scanAuthor` が `extras` を作る前に使う
- **IMPLEMENT**:
  ```ts
  // like-index.ts
  /** 保持期間内の投稿か。取得する前に捨てるために使う */
  export function isWithinRetention(itemPostedAt: IsoDateTime, now: Date): boolean {
    const posted = toEpochMs(itemPostedAt);
    return posted !== null && posted >= now.getTime() - RETENTION_DAYS * MS_PER_DAY;
  }
  ```
  ```ts
  // scanner.ts の scanAuthor
  const extras = listing.data
    .filter((entry) => !seen.has(entry.id))
    // 保持期間より古い記事は取っても purge で消える。取りに行く前に捨てる。
    // 実測（2026-08-24）: 45 記事を取得して保存されたのは 6 本（13%）
    .filter((entry) => isWithinRetention(entry.created_at, now))
    .slice(0, MAX_EXTRA_ITEMS_PER_AUTHOR)
  ```
- **MIRROR**: `withinLookback` / `purgeLikeIndex` と同じ `toEpochMs` の使い方（**パース不能は `null`**、`NaN` 比較が全部 false になる罠を避ける）
- **IMPORTS**: `import { isWithinRetention } from '../detect/like-index';`
- **GOTCHA**:
  - `scanAuthor` は `now` を持っていない。**`scanTrend` から引き回す**（Phase 5b-1 で `const now = new Date(startedAt)` を作ってある）
  - `listing.data` は API の順序（新しい順）。フィルタしてから `slice` すること。**逆にすると新しい 2 本を取ってからフィルタし、0 本になる**
- **VALIDATE**: 「保持期間より古い記事は likes を取りに行かない」テスト

### Task 2: 著者をまたぐ共起の判定

- **ACTION**: `src/detect/cross-cluster.ts` を新規作成
- **IMPLEMENT**:
  ```ts
  /**
   * 別々の著者の記事に、同じ顔ぶれが揃うことを見る。
   *
   * 【なぜ要るか】
   * cluster.ts は著者ごとに閉じているので、記事が 1 本しかない著者は
   * 手順 1 で必ず落ちる。だが実測では、同じ 17 人が 2 人の著者の記事に
   * 揃って現れていた（2026-08-23）。1 人 1 本ずつ投稿して互いに押し合う形は、
   * 著者内の判定では原理的に見えない。
   *
   * 【誤検知をどう防ぐか】
   * 「重なりがある」だけでは足りない。実測 528 ペアのうち 50 組に
   * 重なりがあり、その大半は 1〜3 人（トレンドを見た人がたまたま両方を
   * 押した）。**N 人が揃って現れることと、M 本以上に現れること**の
   * 2 つを課すのは cluster.ts と同じ。
   */
  export function findCrossAuthorClusters(index: LikeIndex, settings: Settings): ClusterHit[];
  ```
  手順:
  1. 記事 → いいねした人の集合を作る（著者で分けない）
  2. **記事を M 本以上いいねした人**を qualifying とする（著者をまたいで数える）
  3. qualifying が `minClusterSize` 未満なら終了
  4. qualifying が `minClusterSize` 人以上揃った記事を集める
  5. **その記事の著者が 2 人以上いること**を確認する（1 人なら著者内クラスタの仕事）
  6. 著者ごとに `ClusterHit` を作る（`sharedItemIds` は**その著者の記事だけ**）
- **MIRROR**: `cluster.ts` の 2 段階の絞り方と `ClusterHit` の形
- **IMPORTS**: `import type { AccountHandle, ItemId, LikeIndex, Settings } from '../types/domain'; import type { ClusterHit } from './cluster';`
- **GOTCHA**:
  - **手順 5 を忘れると、著者内クラスタと同じものを二重に検出する**
  - `sharedItemIds` に他著者の記事を入れない（根拠 URL が壊れる）
  - 計算量は記事数 × アカウント数。実測 33 記事 × 198 アカウントなので素直な二重ループでよい（`cluster.ts` と同じ判断）
- **VALIDATE**: 実測を再現するフィクスチャ（2 著者・1 本ずつ・17 人共通）で 2 件の `ClusterHit` が出ること

### Task 3: 2 つの判定を束ねる

- **ACTION**: `detector.ts` で両方を走らせ、**著者ごとにマージ**する
- **IMPLEMENT**:
  ```ts
  const hits = mergeHitsByAuthor([
    ...findClusters(scoped, settings),
    ...findCrossAuthorClusters(scoped, settings),
  ]);
  ```
  マージ規則:
  - `clusterAccounts` は和集合（昇順）
  - `sharedItemIds` は和集合（昇順）
  - `coAuthors` は「同じクラスタに現れた他の著者」の和集合
  - `burstScore` / `emptyAccountRatio` は**マージ後に 1 度だけ計算**する
- **MIRROR**: `detector.ts` の既存の組み立て（`.map<Candidate>()`）
- **GOTCHA**:
  - **`.map<Candidate>()` の object literal には余剰プロパティ検査が効かない。**型から消したフィールドを tsc が見逃す（Phase 6 で踏んだ）。`coAuthors` を足すときは grep も併用する
  - マージ前に `burstScore` を計算して平均を取ってはいけない。**分母が変わる**
  - 並び順は既存どおり `clusterSize` の降順 → `burstScore` の降順
- **VALIDATE**: 「両方の判定で成立する著者が 1 件にまとまる」テスト

### Task 4: `coAuthors` を型と UI に通す

- **ACTION**: `Candidate.coAuthors?` を足し、ポップアップに 1 行出す
- **IMPLEMENT**:
  ```ts
  // domain.ts
  /**
   * 同じクラスタが現れた他の著者。**著者をまたぐ共起のときだけ入る。**
   * 根拠記事はこの著者のぶんしか持たないので、UI はここで「他にも居る」ことを示す
   */
  coAuthors?: AccountHandle[];
  ```
  ```ts
  // popup-state.ts
  export function describeCoAuthors(coAuthors: AccountHandle[] | undefined): string {
    if (coAuthors === undefined || coAuthors.length === 0) return '';
    return `同じ顔ぶれが ${coAuthors.join('、')} の記事にも現れています。`;
  }
  ```
- **MIRROR**: `describeEmpty` / `describeCall`（純粋関数で文言を作り、`popup-page.ts` は描画だけ）
- **GOTCHA**:
  - **`innerHTML` を使わない**（`textContent` + `createElement`）
  - **断定しない**（約束 6）。「組織票」「不正」と書かない
  - `coAuthors` が無い候補では**行ごと出さない**（空文字で `hidden`）
- **VALIDATE**: XSS テスト（既存の `init の XSS 対策` と同じ形）と、`coAuthors` 無しで行が出ないこと

### Task 5: 実機確認

- **ACTION**: `npm run build` → 拡張を読み込み直す
- **VALIDATE**: 下の Manual Validation

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected | Edge? |
|---|---|---|---|
| **2 著者が 1 本ずつ・N 人共通で成立** | 実測の再現 | `ClusterHit` 2 件 | **本題** |
| 1 人の著者だけなら成立しない | 同一著者の 2 本 | `[]` | **二重検出の番人** |
| 顔ぶれが N 人未満なら成立しない | 4 人共通（閾値 5） | `[]` | 境界 |
| 記事が M 本未満なら成立しない | 1 本だけ | `[]` | 境界 |
| **バラバラの共起では成立しない** | 別々の 5 人が別々の 2 本 | `[]` | **手順 4 の番人** |
| `sharedItemIds` に他著者の記事が混ざらない | 2 著者 | 各自の記事のみ | **根拠 URL の番人** |
| `coAuthors` に自分が入らない | 2 著者 | 相手だけ | |
| 空インデックス | `{}` | `[]` | |
| **両方の判定で成立したら 1 件にまとまる** | 実測の再現 | 著者 B が 1 件 | **適合率の分母の番人** |
| マージ後の `clusterAccounts` が和集合 | 18 人 + 17 人 | 重複なし・昇順 | |
| **保持期間より古い記事は取りに行かない** | `created_at` が 8 日前 | `fetchLikes` 未呼び出し | **OQ-19 の番人** |
| フィルタしてから slice する | 新しい 1 本 + 古い 3 本 | 新しい 1 本だけ | **順序の番人** |
| `coAuthors` が無ければ行を出さない | 著者内クラスタのみ | `hidden` | |
| `coAuthors` の XSS | `<script>` を含むハンドル | テキストとして出る | |

### Edge Cases Checklist

- [ ] 空入力（空インデックス・`coAuthors: []`）
- [ ] 境界（N-1 人 / N 人、M-1 本 / M 本、7 日ちょうど / 8 日）
- [ ] 3 著者以上のクラスタ（`coAuthors` が 2 人以上）
- [ ] 同じ著者が両方の判定で成立
- [ ] `created_at` がパースできない記事
- [ ] 権限拒否 → 該当なし

### 変異テスト（実装後に必ず実施）

**前回、変異を入れるまで弱いテストに気づけなかった**（「429 で記録しない」が、2 人目の存在で必ず通っていた）。今回も必ず実施する。

| 壊す箇所 | 落ちるべきテスト |
|---|---|
| 手順 5（著者が 2 人以上）を外す | 「1 人の著者だけなら成立しない」 |
| 手順 4（N 人が揃った記事）を外す | 「バラバラの共起では成立しない」 |
| `sharedItemIds` に全記事を入れる | 「他著者の記事が混ざらない」 |
| マージをやめて別々の候補にする | 「両方成立したら 1 件にまとまる」 |
| `isWithinRetention` のフィルタを外す | 「古い記事は取りに行かない」 |
| フィルタと `slice` の順序を入れ替える | 「フィルタしてから slice」 |
| `minClusterSize` の比較を `>=` → `>` | 境界 |

**落ちなかったものは、テストが守っていないかコメントが間違っている。** どちらかを確定させるまで進めない。**アサーションが真になる経路が 2 つ無いか**を必ず確認する。

---

## Validation Commands

```bash
npx --no-install tsc --noEmit
```
EXPECT: 0 errors

```bash
npm run lint && npm run format
```
EXPECT: 0 problems ／ **`format` はゲートに入っていないので手で走らせる**

```bash
npm run test -- --run --coverage
```
EXPECT: 全通過・Statements 97% 以上を維持

```bash
npm run build && cat dist/service-worker-loader.js
```
EXPECT: `service-worker.ts-*.js` を指していること

### Manual Validation（実機）

- [ ] `dist/` を未パック拡張として読み込み直す
- [ ] トークンありでトレンドを開く
- [ ] **`fetched:` が大幅に減っている**（OQ-19。実測 45 → 一桁を期待）
- [ ] **`purged:` も減っている**
- [ ] **候補が 2 件になる**（記事 1 本の著者が出る）
- [ ] 候補に「同じ顔ぶれが〈他の著者〉の記事にも現れています」が出る
- [ ] **著者 B が 2 回出ていない**（マージが効いている）
- [ ] 根拠リンクが正しい記事を開く（**他著者の記事 ID で URL が組まれていない**）
- [ ] 「妥当 / 誤り」を押すと適合率が更新される
- [ ] `chrome://extensions` のエラー欄が空のまま

---

## Acceptance Criteria

- [ ] Task 1〜5 完了
- [ ] Validation Commands すべて通過
- [ ] 変異テスト 7 項目すべてで狙ったテストが落ちる
- [ ] **実アカウント名・記事 URL がコード・テスト・ドキュメントに 1 つも無い**
- [ ] 実機で候補が 2 件出る（記事 1 本の著者を捕まえる）

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **母数が 1 組織しかない** | **H** | **M** | 閾値 5 は「正常な記事ペアが引っかからない」ことを 528 ペアで確認済み。**再現率は未知**。適合率フィードバックで追う |
| 著者間の判定が誤検知を増やす | M | H | 手順 4・5 を必ず入れる。実測では閾値 5 で 3 組・うち 1 組は既存判定が拾っているもの |
| マージ漏れで同じ著者が 2 回出る | M | **H** | 適合率の分母が壊れる。テストで固定 |
| **根拠 URL が他著者の記事 ID で組まれる** | M | **H** | 誤った記事をユーザーに見せる。`sharedItemIds` は自分の記事だけ、をテストで固定 |
| `created_at` の絞りで取得がゼロになる | L | M | 著者が 7 日以内に投稿していなければ 0 本。**それが正しい**（取っても捨てられる） |
| Phase 7 が `coAuthors` を前提にし始める | L | M | optional のまま。**非表示は `authorHandle` だけで足りる** |

## Notes

- **`sharedItemCount` の意味が判定によって変わる。** 著者内では「その著者の記事のうち M 本」、著者間では 1 本でもよい。Phase 9 で閾値を触る人が混乱しないよう、`Candidate` のコメントに明記する
- **押した側は候補にしない。** ミュートしても記事は消えないため。この判断は PRD の MVP Scope に沿う
- 実測の数値（33 記事・528 ペア・重なり 17/15/15・4 位以下は 3）は [調査レポート](../reports/cross-author-collusion-investigation.md)にある。**実アカウント名は含まれていない**
- **OQ-19 を先に直すと Task 2 のデータが増える。** 枠が空くので `MAX_EXTRA_ITEMS_PER_AUTHOR` を増やす選択肢が生まれるが、**この計画では増やさない**。実データを見てから決める
