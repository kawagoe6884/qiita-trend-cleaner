# Plan: 検出エンジン（Phase 5）

## Summary

蓄積した逆引きインデックスから「N 人の同じアカウント群が、同一著者の M 本以上の記事に共通していいねしている」クラスタを検出する。バースト（投稿直後の一斉いいね）と空アカウント指標を補強スコアとして付ける。判定は純粋関数だけで構成し、`src/detect/` に閉じる。

Phase 6 の UI はまだ無いため、検出結果は `storage.local` に保存しつつ `logger.info` にも出して `chrome://extensions` から確認できるようにする。これが **OQ-12（ライトモードの射程でクラスタを捕まえられるか）の検証手段**になる。

## User Story

As a Qiita のトレンド面を日常的に開く読者,
I want 組織票と疑われるアカウント群と、その対象著者を自動で洗い出してほしい,
So that 増え続けるアカウントを手動で潰し続ける運用から解放される。

## Problem → Solution

**現在**: `likeIndex` に「誰がどの記事にいつ、いいねしたか」が溜まっているが、そこから何も判定していない。しかもスキャンのたびに上書きされ、1 トレンドセット分しか残らない。

**目標**: 複数のトレンドセットにまたがってインデックスを蓄積し、共起クラスタとバーストを判定して `Candidate[]` を生成する。

## Metadata

- **Complexity**: Large
- **Source PRD**: `.claude/PRPs/prds/qiita-trend-guard.prd.md`
- **PRD Phase**: Phase 5（検出エンジン）— depends on 3, 4（両方 complete）
- **Estimated Files**: 新規 8 / 変更 4

---

## この計画で確定させた 2 つの判断（ユーザー確認済み）

### 判断 1: インデックスを蓄積する

**ライトモードは 1 回のスキャンでは原理的に発火しない。** トレンド 30 件の中に同一著者の記事が 2 本入ることが稀で、M=2 を満たせないため。

PRD の設計はこれを蓄積で解いている。

| 根拠 | 記述 |
|---|---|
| `Settings.lookbackDays: 3` | 「直近 3 日」＝ **トレンドセット 6 回分**（PRD L153） |
| `LocalState.purgeAfter` | 「保持期間 7 日」（PRD L352） |
| Phase 5 スコープ | 「逆引きインデックス**構築**」 |

したがって `scanner.ts` の上書き保存をやめ、**マージ + パージ**に変える。

**トレードオフ（実装前に理解しておくこと）**: 定期実行を廃止した（改訂 5）ため、蓄積の機会は `onInstalled` / `onStartup` / 手動の 3 つしかない。**初回スキャン直後は候補ゼロが正常**であり、数日かけて効いてくる。「動かない」と誤認しないよう、ログに蓄積状況（レコード数・パージ数）を出す。

### 判断 2: OQ-12 の検証は `logger.info` で行う

Phase 6 の候補一覧 UI を前倒ししない。検出した候補を service worker のログに出し、`chrome://extensions` で確認する。Phase 6 ができたら表示に差し替える。

---

## UX Design

### Before

```
┌──────────────────────────────────────────┐
│ chrome://extensions のログ               │
│                                          │
│ [QTG] scan started: mode=light items: 30 │
│ [QTG] scan finished: mode=light          │
│         items: 30 likes: 591             │
│         truncated: false                 │
│                                          │
│ → 591 件のいいねを集めたが、             │
│    そこから何も分からない                │
└──────────────────────────────────────────┘
```

### After

```
┌──────────────────────────────────────────┐
│ chrome://extensions のログ               │
│                                          │
│ [QTG] scan started: mode=light items: 30 │
│ [QTG] index merged: accounts: 412        │
│         records: 1180 purged: 0          │
│ [QTG] scan finished: ...                 │
│ [QTG] detected 2 candidates              │
│         (N>=5 M>=2 within 3d)            │
│ [QTG]   candidate: author=<handle>       │
│           cluster: 7 shared: 3           │
│           burst: 0.71 empty: 0.86        │
│ [QTG]   candidate: author=<handle>       │
│           cluster: 5 shared: 2           │
│           burst: 0.20 empty: 0.40        │
└──────────────────────────────────────────┘
```

候補ゼロのときも必ず 1 行出す。蓄積待ちなのか閾値に届かないのかが分かるよう、レコード数を併記する。

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| スキャン後のログ | 取得件数のみ | ＋ 蓄積状況と候補 | OQ-12 の検証手段 |
| `storage.local` の `likeIndex` | 毎回上書き | マージして蓄積、7 日でパージ | 10 MB 上限に注意 |
| `storage.local` の `candidates` | 未使用 | 検出結果を保存 | Phase 6 の入力になる |
| ユーザー操作 | 変化なし | 変化なし | Phase 5 に UI は無い |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/types/domain.ts` | all | `LikeRecord` / `AccountIndexEntry` / `Candidate` / `Settings` の定義。今回拡張する |
| P0 | `src/background/scanner.ts` | 1-70, 174-260 | `foldLikes` のインデックス構築と `persistScan` の保存。上書きをマージに変える |
| P0 | `src/api/rate-budget.ts` | all | **純粋関数だけで構成する層のお手本。** `src/detect/` はこれと同じ思想で書く |
| P1 | `src/lib/storage.ts` | all | storage アクセスの唯一の窓口。`candidates` のアクセサを追加する |
| P1 | `src/background/scanner.test.ts` | 1-55 | モックの組み方とフィクスチャ生成関数（`trendItem` / `likeOf` / `likesResponse`） |
| P2 | `src/feed/atom-parser.ts` | 1-60 | フェイルセーフ（例外を投げず既定値を返す）とコメントの書き方 |
| P2 | `src/lib/storage.test.ts` | all | storage のテストパターン（`setup.ts` が beforeEach でストアを新品に差し替える） |

## External Documentation

外部研究は不要。**この機能は集合演算と日時差分だけで完結し、新しいライブラリも API も使わない。**既存の内部パターン（純粋関数層 + storage 層 + scanner のオーケストレーション）にそのまま乗る。

`Date` の扱いだけ 1 点:

```
KEY_INSIGHT: new Date("2026-08-18T17:00:41+09:00").getTime() はオフセットを正しく解釈する
APPLIES_TO: burst.ts の Δ 計算、like-index.ts のパージ判定
GOTCHA: 不正な文字列では NaN になり、NaN との比較はすべて false になる。
        「範囲外」と「パースできない」が区別なく落ちるため、Number.isNaN で明示的に弾く
```

---

## Patterns to Mirror

### 純粋関数層の構成（PURE_LAYER）

```ts
// SOURCE: src/api/rate-budget.ts:1-21
/**
 * Qiita API のレート枠の読み取りと判断。
 *
 * この層は純粋関数だけで構成する（storage も fetch も触らない）。
 * 「どこまで取りに行ってよいか」の判断をテスト可能な形で 1 箇所に集める。
 */
import type { ScanMode } from '../types/domain';

export const RATE_LIMIT_ANON = 60;
export const RATE_LIMIT_AUTH = 1000;

/**
 * 枠を使い切る手前で止めるための余白。
 * 0 まで使うと、他の経路（Phase 3 の疎通確認など）が即座に 429 になる。
 */
export const RATE_SAFETY_MARGIN = 5;
```

**要点**: マジックナンバーは名前付き定数にし、**なぜその値なのかをコメントに書く**。`src/detect/` の閾値もこれに倣う。

### 命名（NAMING_CONVENTION）

```ts
// SOURCE: src/api/rate-budget.ts:38-66
export function readRateHeaders(headers: Headers): RateState | null { ... }
export function decideMode(hasToken: boolean): ScanMode { ... }
export function fallbackLimitFor(mode: ScanMode): number { ... }
export function availableRequests(state: RateState | null, fallbackLimit: number): number { ... }
```

- 関数: `camelCase`、動詞始まり（`readX` / `decideX` / `buildX` / `detectX`）
- 型・インターフェース: `PascalCase`
- 定数: `UPPER_SNAKE_CASE`
- ファイル: `kebab-case.ts`、テストは同階層の `kebab-case.test.ts`

### フェイルセーフ（ERROR_HANDLING）

```ts
// SOURCE: src/feed/atom-parser.ts:66-79
export function parseEntry(entryXml: string): TrendItem | null {
  const link = ITEM_LINK_PATTERN.exec(entryXml);
  const url = link?.[1];
  if (!url) return null;
  ...
}
```

```ts
// SOURCE: src/lib/storage.ts:70-77
export async function getLikeIndex(): Promise<LikeIndex> {
  const raw = await readRaw();
  const index = raw.likeIndex;
  if (typeof index !== 'object' || index === null || Array.isArray(index)) {
    return DEFAULT_LIKE_INDEX;
  }
  return index as LikeIndex;
}
```

**要点**: 判定層は例外を投げない。**壊れたレコード 1 件でスキャン全体を失敗させない。**`atom-parser` が壊れた entry を捨てて残りを返すのと同じ方針で、日時がパースできない `LikeRecord` は捨てて残りで判定する。

### ログ（LOGGING_PATTERN）

```ts
// SOURCE: src/background/scanner.ts:206-216
logger.info(
  'scan finished: mode=' + mode,
  'items:',
  progress.scannedItemCount,
  'likes:',
  progress.likeRecordCount,
  'truncated:',
  progress.truncated,
  'rate-remaining:',
  progress.rate?.remaining ?? 'unknown',
);
```

**要点（CLAUDE.md の約束 11）**: 想定内の失敗は `logger.debug`。`warn` / `error` は「拡張が壊れている」と読まれる。**Chrome は `console.warn` も `chrome://extensions` のエラー欄に集める。**検出の結果（候補ゼロを含む）はすべて `info`。

### 逆引きインデックスの畳み込み（INDEX_FOLD）

```ts
// SOURCE: src/background/scanner.ts:33-52
function foldLikes(index: LikeIndex, item: TrendItem, likes: QiitaLike[]): number {
  for (const like of likes) {
    const handle = like.user.id;
    // noUncheckedIndexedAccess のため undefined を考慮する
    const entry = index[handle] ?? {
      likes: [],
      itemsCount: like.user.items_count,
      followersCount: like.user.followers_count,
      hasDescription: typeof like.user.description === 'string' && like.user.description !== '',
    };
    entry.likes.push({
      itemId: item.itemId,
      authorHandle: item.authorHandle,
      likedAt: like.created_at,
      itemPostedAt: item.publishedAt,
    });
    index[handle] = entry;
  }
  return likes.length;
}
```

**要点**: `noUncheckedIndexedAccess` が有効なので、`Record` の添字アクセスは必ず `undefined` を考慮する。`??` でのデフォルト生成がこのコードベースの流儀。

### テスト（TEST_STRUCTURE）

```ts
// SOURCE: src/background/scanner.test.ts:15-39
function trendItem(index: number) {
  const handle = `example-author-${index}`;
  const itemId = `0123456789abcdef${String(index).padStart(4, '0')}`;
  return {
    itemId,
    url: `https://qiita.com/${handle}/items/${itemId}`,
    authorHandle: handle,
    publishedAt: '2026-08-18T10:00:00+09:00',
  };
}
```

```ts
// SOURCE: src/lib/storage.test.ts:15-31
describe('getToken', () => {
  it('未設定なら null を返す', async () => {
    // Arrange — setup.ts が beforeEach でストアを新品に差し替える
    // Act
    const token = await getToken();
    // Assert
    expect(token).toBeNull();
  });
});
```

**要点**:
- `describe` / `it` は**日本語**で振る舞いを書く
- Arrange / Act / Assert をコメントで明示（自明な短いテストは省略可）
- フィクスチャは**すべて合成値**。`example-author-N` / `example-liker-N` / `0123456789abcdefNNNN`。**実アカウント名・実 item_id をリポジトリに持ち込まない**（CLAUDE.md の記事化制約）

---

## 検出アルゴリズムの定義

### 用語

| 記号 | `Settings` のキー | 既定値 | 意味 |
|---|---|---|---|
| N | `minClusterSize` | 5 | クラスタを構成するアカウント数の下限 |
| M | `minSharedItems` | 2 | 共通していいねされた記事数の下限 |
| D | `lookbackDays` | 3 | 判定に使う記事の遡及日数（＝トレンドセット 6 回分） |

### クラスタ判定（2 段階の絞り込み）

著者 A ごとに:

```
1. itemsByA  = 遡及窓 D 内で A が書いた記事の集合（distinct itemId）
   |itemsByA| < M なら打ち切り

2. perAccount[acct] = acct が itemsByA のうちいいねした記事の集合

3. qualifying = { acct : |perAccount[acct]| >= M }
   ── 「A の記事を複数本いいねしている顔ぶれ」
   |qualifying| < N なら打ち切り

4. sharedItems = { item ∈ itemsByA : |likers(item) ∩ qualifying| >= N }
   ── 「その顔ぶれが N 人以上そろって現れた記事」
   |sharedItems| < M なら打ち切り

5. → Candidate を生成
```

**なぜ 2 段階か**: 手順 3 だけだと「A の記事を 2 本いいねした人が別々に 5 人いる」でも成立してしまう。手順 4 で「**同じ顔ぶれが同じ記事に揃っている**」ことを確認する。PRD の Decisions Log が「単一アカウントの共起ではなくアカウント群のクラスタ性」を判定単位に選んだ理由がここにある。

**計算量**: 記事数 × アカウント数。ライトモードで 30 記事 × 約 600 レコードなので、素直な二重ループで十分。最適化しない。

### バーストスコア

```
Δ = likedAt - itemPostedAt

burstScore = (sharedItems 上の qualifying による いいね のうち 0 <= Δ <= BURST_WINDOW_MINUTES のもの)
             ────────────────────────────────────────────────────────────────────────────────
             (sharedItems 上の qualifying による いいね の総数)
```

- `BURST_WINDOW_MINUTES = 60`（新規定数。投稿から 1 時間以内を「直後」とする）
- Δ < 0（記事投稿より前のいいね）は**データ不整合**なので分母からも除く
- 日時がパースできないレコードは分母からも除く
- 分母が 0 なら `burstScore = 0`（ゼロ除算を作らない）

### 空アカウント指標

```
isEmptyAccount(entry) =
  entry.itemsCount === 0
  && !entry.hasDescription
  && entry.followersCount <= EMPTY_MAX_FOLLOWERS

emptyAccountRatio = |{ acct ∈ clusterAccounts : isEmptyAccount(acct) }| / |clusterAccounts|
```

- `EMPTY_MAX_FOLLOWERS = 5`（新規定数）
- **これは補強スコアであって判定条件ではない。** PRD の Phase 9 で重みを調整する前提なので、Phase 5 では閾値によるフィルタに使わず、値を記録するだけにする

### 蓄積とパージ

| 窓 | 定数 | 用途 |
|---|---|---|
| 保持 7 日 | `RETENTION_DAYS = 7` | `storage` から捨てる。PRD L352 / L565 の「保持期間 7 日」 |
| 遡及 3 日 | `Settings.lookbackDays` | 判定の入力を絞る。ユーザーが Phase 6 で調整する |

- どちらも **`itemPostedAt`**（記事の投稿時刻）を基準にする。「直近 3 日の記事」という PRD の言い回しに従う
- マージの重複判定キーは **アカウント内で `itemId`**。同じアカウントが同じ記事に 2 回いいねすることは無いため、`itemId` の重複は「前回のスキャンでも同じ記事を見た」を意味する。**新しい方の値で置き換える**
- アカウントのメタデータ（`itemsCount` / `followersCount` / `hasDescription`）は**新しい方で上書き**する。アカウントは成長するため
- パージ後に `likes` が空になったアカウントは**エントリごと削除**する。10 MB 上限への配慮

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/detect/like-index.ts` | CREATE | インデックスのマージ・パージ・遡及フィルタ（純粋関数） |
| `src/detect/like-index.test.ts` | CREATE | 同上のテスト |
| `src/detect/cluster.ts` | CREATE | 共起クラスタ判定（純粋関数） |
| `src/detect/cluster.test.ts` | CREATE | 同上のテスト |
| `src/detect/burst.ts` | CREATE | バーストスコアと空アカウント指標（純粋関数） |
| `src/detect/burst.test.ts` | CREATE | 同上のテスト |
| `src/detect/detector.ts` | CREATE | 上 3 つを束ねて `Candidate[]` を返す入口 |
| `src/detect/detector.test.ts` | CREATE | 同上のテスト |
| `src/types/domain.ts` | UPDATE | `Candidate` に `emptyAccountRatio` と `sharedItemIds` を追加 |
| `src/lib/storage.ts` | UPDATE | `getCandidates` / `saveCandidates` を追加 |
| `src/background/scanner.ts` | UPDATE | 上書き保存をマージ + パージに変え、検出を呼び、候補をログに出す |
| `src/background/scanner.test.ts` | UPDATE | 蓄積と検出の呼び出しに関する回帰テストを追加 |

## NOT Building

- **候補一覧 UI・スライダー・適合率フィードバック** — Phase 6
- **DOM 非表示・除外件数バッジ** — Phase 7
- **一括ミュート実行** — Phase 8
- **閾値のチューニング** — Phase 9。Phase 5 は `DEFAULT_SETTINGS` の値をそのまま使う
- **`Settings` の永続化と読み書き UI** — Phase 6。Phase 5 は `DEFAULT_SETTINGS` を直接渡す
- **判定ロジックの 2 本目** — CLAUDE.md の約束 9。ライト／フルの違いは**入力する記事集合だけ**にする。`detectCandidates` はモードを引数に取らない
- **`QtgError` への `code` 追加**（orch-review の advisory）— 別タスク。この計画では触らない

---

## Step-by-Step Tasks

### Task 1: `Candidate` 型の拡張

- **ACTION**: `src/types/domain.ts` の `Candidate` にフィールドを 2 つ追加する
- **IMPLEMENT**:
  ```ts
  /** 検出された組織票の候補 */
  export interface Candidate {
    authorHandle: AccountHandle;
    clusterAccounts: AccountHandle[];
    /** M: クラスタが N 人そろって現れた記事の数 */
    sharedItemCount: number;
    /** 根拠として提示する記事。Phase 6 の一覧で「なぜ」を示すために持つ */
    sharedItemIds: ItemId[];
    /** N: クラスタを構成するアカウント数 */
    clusterSize: number;
    /** 0.0-1.0。投稿直後に集中したいいねの割合 */
    burstScore: number;
    /** 0.0-1.0。クラスタのうち記事 0 本・プロフィール空のアカウントの割合 */
    emptyAccountRatio: number;
    detectedAt: IsoDateTime;
    verdict: Verdict | null;
  }
  ```
- **MIRROR**: 既存の `Candidate` のコメントスタイル（`/** N: ... */`）
- **IMPORTS**: 追加不要（`ItemId` は同ファイル内で定義済み）
- **GOTCHA**: `sharedItemCount` は既存フィールドだが、コメントの意味を「共通していいねされた記事数」から「**クラスタが N 人そろって現れた記事の数**」に精密化する。アルゴリズム定義の手順 4 と一致させること
- **VALIDATE**: `npm run typecheck` — `Candidate` を構築している箇所がまだ無いためエラーは出ないはず

### Task 2: `src/detect/like-index.ts` — 蓄積とパージ

- **ACTION**: 新規ファイル。インデックスのマージ・パージ・遡及フィルタを純粋関数で書く
- **IMPLEMENT**:
  - `export const RETENTION_DAYS = 7;` — なぜ 7 日かをコメントに（利用規約第 11 条 5 項 1 号との距離）
  - `export function toEpochMs(iso: IsoDateTime): number | null` — `Number.isNaN` で弾いて `null` を返す
  - `export function mergeLikeIndex(stored: LikeIndex, fresh: LikeIndex): LikeIndex`
    - 新しいオブジェクトを返す（`stored` を破壊しない）
    - アカウント単位で `likes` を `itemId` キーの Map に畳んで重複排除。**`fresh` 側を優先**
    - メタデータは `fresh` 側で上書き
  - `export function purgeLikeIndex(index: LikeIndex, now: Date): { index: LikeIndex; purgedRecords: number }`
    - `itemPostedAt` が `now - RETENTION_DAYS` より古いレコードを捨てる
    - パース不能なレコードも捨てる（残しても判定に使えないため）
    - `likes` が空になったアカウントはエントリごと削除
  - `export function withinLookback(index: LikeIndex, lookbackDays: number, now: Date): LikeIndex`
    - 判定の入力を作る。保存はしない
  - `export function countRecords(index: LikeIndex): number` — ログ用
- **MIRROR**: `PURE_LAYER`（rate-budget.ts）— storage も fetch も触らない。`INDEX_FOLD` — `noUncheckedIndexedAccess` への配慮
- **IMPORTS**:
  ```ts
  import type { IsoDateTime, LikeIndex, LikeRecord } from '../types/domain';
  ```
- **GOTCHA**:
  - **`now` を引数で受け取る。** 関数内で `new Date()` を呼ぶとテストが時刻に依存して壊れる
  - 破壊的変更をしない（coding-style の immutability）。`scanner.ts` の `foldLikes` はローカルの作業用オブジェクトを更新しているが、**こちらは storage から読んだ値を扱うため新しいオブジェクトを返す**
  - `noUncheckedIndexedAccess` 下の添字アクセスは `undefined` を含む
- **VALIDATE**: `npx vitest run src/detect/like-index.test.ts`

### Task 3: `src/detect/like-index.test.ts`

- **ACTION**: Task 2 のテストを書く
- **IMPLEMENT**: 下の Testing Strategy の「like-index」節をすべて実装する
- **MIRROR**: `TEST_STRUCTURE`
- **IMPORTS**:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { mergeLikeIndex, purgeLikeIndex, withinLookback, countRecords } from './like-index';
  import type { LikeIndex } from '../types/domain';
  ```
- **GOTCHA**: フィクスチャは合成値のみ。`now` は固定値（`new Date('2026-08-19T12:00:00+09:00')`）を渡す
- **VALIDATE**: 全テストが通り、かつ**マージの重複排除を外すと落ちる**ことを確認する

### Task 4: `src/detect/cluster.ts` — 共起クラスタ判定

- **ACTION**: 新規ファイル。アルゴリズム定義の手順 1〜5 を実装する
- **IMPLEMENT**:
  - `export interface ClusterHit { authorHandle: AccountHandle; clusterAccounts: AccountHandle[]; sharedItemIds: ItemId[]; }`
  - `export function findClusters(index: LikeIndex, settings: Settings): ClusterHit[]`
    - 手順 1: 著者ごとに記事集合を作る（`LikeRecord.authorHandle` と `itemId` から）
    - 手順 2-3: `perAccount` を作り `qualifying` を絞る
    - 手順 4: `sharedItems` を絞る
    - 手順 5: `ClusterHit` を返す
  - 結果は `clusterAccounts` と `sharedItemIds` を**ソートして返す**（テストの安定と、Phase 6 の表示順の安定のため）
- **MIRROR**: `PURE_LAYER` / `NAMING_CONVENTION`
- **IMPORTS**:
  ```ts
  import type { AccountHandle, ItemId, LikeIndex, Settings } from '../types/domain';
  ```
- **GOTCHA**:
  - **著者の記事集合は「その著者の記事にいいねが 1 件でも付いている」ものしか見えない。** インデックスは likers から逆算しているため、いいねゼロの記事は存在しない。これは仕様であって欠陥ではない（いいねゼロの記事に組織票クラスタは無い）
  - 手順 3 を通っても手順 4 で落ちるケースがある。**手順 3 だけで候補を作らないこと**（そこが誤検知の入口）
  - `Set` の交差は `[...a].filter((x) => b.has(x))` で書く。`Set.prototype.intersection` は環境によって無い
- **VALIDATE**: `npx vitest run src/detect/cluster.test.ts`

### Task 5: `src/detect/cluster.test.ts`

- **ACTION**: Task 4 のテストを書く
- **IMPLEMENT**: Testing Strategy の「cluster」節をすべて実装する。**特に「手順 3 は通るが手順 4 で落ちる」ケースを必ず入れる**
- **MIRROR**: `TEST_STRUCTURE`
- **GOTCHA**: フィクスチャを組むときは「誰が・どの記事に・誰の記事か」を明示的に書く。ヘルパーで隠すと、テストが何を主張しているのか読めなくなる
- **VALIDATE**: 手順 4 の絞り込みを外すと、該当テストが落ちること

### Task 6: `src/detect/burst.ts` — バーストと空アカウント

- **ACTION**: 新規ファイル
- **IMPLEMENT**:
  - `export const BURST_WINDOW_MINUTES = 60;` — なぜ 60 分かをコメントに
  - `export const EMPTY_MAX_FOLLOWERS = 5;`
  - `export function burstScore(index: LikeIndex, hit: ClusterHit): number`
    - アルゴリズム定義のとおり。分母 0 なら 0 を返す
  - `export function emptyAccountRatio(index: LikeIndex, accounts: AccountHandle[]): number`
    - 空配列なら 0 を返す
- **MIRROR**: `PURE_LAYER`
- **IMPORTS**:
  ```ts
  import { toEpochMs } from './like-index';
  import type { AccountHandle, LikeIndex } from '../types/domain';
  import type { ClusterHit } from './cluster';
  ```
- **GOTCHA**:
  - `new Date(iso).getTime()` は不正文字列で `NaN`。**`NaN` との比較はすべて false になるため、「範囲外」と「壊れている」が区別なく落ちる。**`toEpochMs` の `null` で明示的に弾き、分母にも入れない
  - Δ < 0 を弾き忘れると、データ不整合が「バーストではない」として分母を膨らませ、スコアを不当に下げる
- **VALIDATE**: `npx vitest run src/detect/burst.test.ts`

### Task 7: `src/detect/burst.test.ts`

- **ACTION**: Task 6 のテストを書く
- **IMPLEMENT**: Testing Strategy の「burst」節
- **GOTCHA**: 境界（ちょうど 60 分）を必ずテストする。`<=` か `<` かで結果が変わる
- **VALIDATE**: 全テスト通過

### Task 8: `src/detect/detector.ts` — 入口

- **ACTION**: 新規ファイル。3 つを束ねて `Candidate[]` を返す
- **IMPLEMENT**:
  ```ts
  export function detectCandidates(
    index: LikeIndex,
    settings: Settings,
    now: Date,
  ): Candidate[] {
    const scoped = withinLookback(index, settings.lookbackDays, now);
    const hits = findClusters(scoped, settings);
    return hits.map((hit) => ({
      authorHandle: hit.authorHandle,
      clusterAccounts: hit.clusterAccounts,
      clusterSize: hit.clusterAccounts.length,
      sharedItemIds: hit.sharedItemIds,
      sharedItemCount: hit.sharedItemIds.length,
      burstScore: burstScore(scoped, hit),
      emptyAccountRatio: emptyAccountRatio(scoped, hit.clusterAccounts),
      detectedAt: now.toISOString(),
      verdict: null,
    }));
  }
  ```
  - 返す前に `clusterSize` の降順 → `burstScore` の降順でソートする（Phase 6 で「怪しい順」に出せるように）
- **MIRROR**: `PURE_LAYER`
- **IMPORTS**:
  ```ts
  import { withinLookback } from './like-index';
  import { findClusters } from './cluster';
  import { burstScore, emptyAccountRatio } from './burst';
  import type { Candidate, LikeIndex, Settings } from '../types/domain';
  ```
- **GOTCHA**: **モードを引数に取らない。** CLAUDE.md の約束 9。ライトとフルの違いは `index` の中身だけ
- **VALIDATE**: `npx vitest run src/detect/detector.test.ts`

### Task 9: `src/detect/detector.test.ts`

- **ACTION**: Task 8 のテストを書く
- **IMPLEMENT**: Testing Strategy の「detector」節。**「ライトモード相当の入力（同一著者 2 記事）でも検出される」ことを明示的にテストする** — これが OQ-12 の単体テストでの再現
- **VALIDATE**: 全テスト通過

### Task 10: `src/lib/storage.ts` — 候補のアクセサ

- **ACTION**: `getCandidates` / `saveCandidates` を追加する
- **IMPLEMENT**:
  ```ts
  export async function getCandidates(): Promise<Candidate[]> {
    const raw = await readRaw();
    const list = raw.candidates;
    if (!Array.isArray(list)) return [];
    return list as Candidate[];
  }

  export async function saveCandidates(candidates: Candidate[]): Promise<void> {
    await chrome.storage.local.set({ candidates });
  }
  ```
- **MIRROR**: `ERROR_HANDLING`（`getLikeIndex` の壊れた値への対処）
- **IMPORTS**: `Candidate` を `../types/domain` の import に追加
- **GOTCHA**: `getLikeIndex` は「配列なら既定値」と判定しているが、`candidates` は**配列であることが正しい**。判定の向きを逆にすること
- **VALIDATE**: `npm run typecheck`

### Task 11: `src/background/scanner.ts` — 蓄積と検出の組み込み

- **ACTION**: `persistScan` の保存処理を差し替え、検出を呼び、ログを出す
- **IMPLEMENT**:
  - `persistScan` の `await storage.saveLikeIndex(index);` を次に置き換える:
    ```ts
    const stored = await storage.getLikeIndex();
    const merged = mergeLikeIndex(stored, index);
    const { index: kept, purgedRecords } = purgeLikeIndex(merged, new Date());
    await storage.saveLikeIndex(kept);

    logger.info(
      'index merged:',
      'accounts:',
      Object.keys(kept).length,
      'records:',
      countRecords(kept),
      'purged:',
      purgedRecords,
    );

    const candidates = detectCandidates(kept, DEFAULT_SETTINGS, new Date());
    await storage.saveCandidates(candidates);
    logCandidates(candidates);
    ```
  - `logCandidates` を新設する（`persistScan` を 50 行以内に保つため）:
    ```ts
    /**
     * 検出結果をログに出す。Phase 6 の候補一覧 UI ができるまでの唯一の確認手段であり、
     * OQ-12（ライトモードの射程で捕まえられるか）の検証もここで行う。
     *
     * ゼロ件のときも必ず 1 行出す。定期実行を持たない設計では初回スキャン直後の
     * ゼロ件が正常であり、「動いていない」と誤認させないため。
     */
    function logCandidates(candidates: Candidate[]): void {
      logger.info(
        'detected',
        candidates.length,
        'candidates (N>=' + String(DEFAULT_SETTINGS.minClusterSize),
        'M>=' + String(DEFAULT_SETTINGS.minSharedItems),
        'within ' + String(DEFAULT_SETTINGS.lookbackDays) + 'd)',
      );
      for (const c of candidates) {
        logger.info(
          '  candidate: author=' + c.authorHandle,
          'cluster:',
          c.clusterSize,
          'shared:',
          c.sharedItemCount,
          'burst:',
          c.burstScore.toFixed(2),
          'empty:',
          c.emptyAccountRatio.toFixed(2),
        );
      }
    }
    ```
- **MIRROR**: `LOGGING_PATTERN`
- **IMPORTS**:
  ```ts
  import { mergeLikeIndex, purgeLikeIndex, countRecords } from '../detect/like-index';
  import { detectCandidates } from '../detect/detector';
  import { DEFAULT_SETTINGS } from '../types/domain';
  import type { Candidate } from '../types/domain';
  ```
- **GOTCHA**:
  - **打ち切り時（`truncated`）でもマージは行う。** 既存コードは `truncated` のとき `saveFeedCache` を呼ばないが、**インデックスは打ち切り時も保存している**（「途中まででも成果は捨てない」）。マージも同じ扱いにする
  - **検出は `truncated` でも走らせる。** 不完全なインデックスでも候補が出るなら出す。次のスキャンで補強される
  - `persistScan` が 50 行を超えないよう、ログは別関数に切る（code-review の基準）
  - **候補が出てもユーザーに何もしない。** Phase 5 に UI は無く、ミュートも非表示も行わない
- **VALIDATE**: `npm run test` — 既存の scanner テストが通ること

### Task 12: `src/background/scanner.test.ts` — 蓄積と検出の回帰テスト

- **ACTION**: テストを追加する
- **IMPLEMENT**: Testing Strategy の「scanner 統合」節
- **GOTCHA**:
  - 既存テスト「likers をアカウント単位に畳んで保存する」は `setup.ts` が `beforeEach` でストアを新品にするため通るはず。落ちたら蓄積の副作用を疑う
  - **`detect/` をモックしない。** 実物を通して統合を確かめる。ここをモックすると「配線されているか」が検証できない
- **VALIDATE**: `npm run test`

### Task 13: 全体検証と OQ-12 の実機確認

- **ACTION**: 検証コマンドをすべて流し、実機で確認する
- **IMPLEMENT**: 下の Validation Commands をすべて実行する
- **GOTCHA**: **ビルド成功は「正しく動く」を意味しない**（CLAUDE.md）。`dist/` の配線を必ず確認する
- **VALIDATE**: Manual Validation のチェックリストをすべて満たす

---

## Testing Strategy

### like-index

| Test | Input | Expected | Edge? |
|---|---|---|---|
| 空の蓄積に初回分をマージすると全件入る | `{}` + 2 アカウント | 2 アカウント | |
| 同じ記事を 2 回スキャンしても重複しない | 同じ `itemId` を含む 2 回のマージ | レコード数が増えない | ✅ |
| 別のトレンドセットの記事は追加される | 異なる `itemId` | レコード数が加算される | |
| メタデータは新しい方で上書きされる | `itemsCount` 0 → 3 | 3 になる | |
| 元のインデックスを破壊しない | マージ後に `stored` を検査 | 変化なし | ✅ |
| 保持期間を過ぎたレコードを捨てる | 8 日前の `itemPostedAt` | 捨てられる | |
| 保持期間ちょうどは残す | 7 日ちょうど | 残る | ✅ |
| 全レコードが消えたアカウントはエントリごと消える | 古いレコードのみのアカウント | キーが存在しない | ✅ |
| 日時がパースできないレコードは捨てる | `itemPostedAt: 'not-a-date'` | 捨てられ、例外は投げない | ✅ |
| 遡及フィルタは元のインデックスを変えない | `withinLookback` の戻り値を変更 | 元は不変 | ✅ |

### cluster

| Test | Input | Expected | Edge? |
|---|---|---|---|
| N 人が同一著者の M 本に揃えば検出する | 5 アカウント × 2 記事（同一著者） | 1 件 | |
| N に 1 人足りなければ検出しない | 4 アカウント × 2 記事 | 0 件 | ✅ |
| M に 1 本足りなければ検出しない | 5 アカウント × 1 記事 | 0 件 | ✅ |
| **手順 3 は通るが手順 4 で落ちる** | 5 アカウントが「A の 2 本」をいいねするが、記事ごとの顔ぶれがバラバラ（各記事に 3 人ずつ） | **0 件** | ✅ |
| 著者が違えば別候補になる | 2 著者それぞれにクラスタ | 2 件 | |
| 著者をまたいだ共起は 1 つにまとめない | 同じ顔ぶれが 2 著者に | 著者ごとに 1 件ずつ | ✅ |
| いいねが 1 件も無い記事は考慮されない | — | 例外を投げない | ✅ |
| 空のインデックス | `{}` | `[]` | ✅ |
| 結果はソートされている | 順不同の入力 | `clusterAccounts` が昇順 | |

### burst

| Test | Input | Expected | Edge? |
|---|---|---|---|
| 全員が投稿直後なら 1.0 | Δ = 10 分 × 全件 | 1.0 | |
| 全員が翌日なら 0.0 | Δ = 24 時間 | 0.0 | |
| 半々なら 0.5 | 5 件が窓内、5 件が窓外 | 0.5 | |
| ちょうど 60 分は窓内 | Δ = 60 分 | 分子に入る | ✅ |
| 61 分は窓外 | Δ = 61 分 | 分子に入らない | ✅ |
| Δ < 0 は分母からも除く | `likedAt` < `itemPostedAt` | 無視される | ✅ |
| パース不能な日時は分母からも除く | `'not-a-date'` | 例外を投げず無視 | ✅ |
| 対象レコードが 0 件なら 0.0 | 空 | 0.0（NaN ではない） | ✅ |
| 空アカウント割合: 全員空なら 1.0 | items 0 / desc なし / followers 0 | 1.0 | |
| 空アカウント割合: followers が閾値超なら空扱いしない | followers 6 | 除外される | ✅ |
| 空アカウント割合: 空配列なら 0.0 | `[]` | 0.0 | ✅ |

### detector

| Test | Input | Expected | Edge? |
|---|---|---|---|
| **ライトモード相当でも検出できる（OQ-12）** | 同一著者の 2 記事 + 5 アカウント。すべて同一トレンドセット | 1 件 | ✅ |
| 遡及窓の外の記事は判定に入らない | 4 日前の記事（`lookbackDays: 3`） | 0 件 | ✅ |
| `Candidate` の全フィールドが埋まる | 検出されるケース | `verdict` は `null`、他は値あり | |
| `detectedAt` は渡した `now` になる | 固定 `now` | 一致する | ✅ |
| クラスタサイズの降順に並ぶ | 大小 2 件 | 大きい方が先 | |
| 検出ゼロなら空配列 | 閾値未満 | `[]`（`null` ではない） | ✅ |

### scanner 統合

| Test | Input | Expected | Edge? |
|---|---|---|---|
| 2 回スキャンするとインデックスが蓄積される | 別々の `itemId` で 2 回 | レコード数が加算される | ✅ |
| 同じフィードを 2 回処理しても重複しない | 同じ `itemId` で 2 回 | レコード数が変わらない | ✅ |
| 検出結果が storage に保存される | クラスタを含む入力 | `getCandidates()` が返す | |
| 候補ゼロでも空配列が保存される | クラスタなし | `[]` | ✅ |
| 打ち切っても蓄積と検出は行う | `truncated: true` | インデックスが保存される | ✅ |
| 検出結果が `logger.info` に出る | クラスタを含む入力 | `'detected'` を含む呼び出しがある | |
| **検出は warn / error を出さない** | ゼロ件・クラスタあり両方 | `logger.warn` が呼ばれない | ✅ |

### Edge Cases Checklist

- [ ] 空のインデックス（初回スキャン前）
- [ ] 1 アカウントだけのインデックス
- [ ] 全レコードが遡及窓の外
- [ ] 日時文字列が壊れている（`likedAt` / `itemPostedAt` の両方）
- [ ] 同一アカウントが同一記事に複数レコードを持つ（マージのバグで起きうる）
- [ ] `Settings` の値が 0（`minClusterSize: 0` などの防御）
- [ ] 10 MB 上限に近いインデックス（パージが効いているか）
- [ ] 権限・ネットワークは Phase 5 では発生しない（純粋関数のため）

---

## Validation Commands

### Static Analysis

```bash
npm run typecheck
```

EXPECT: エラー 0 件

### Lint

```bash
npm run lint
```

EXPECT: 警告・エラー 0 件。**`console` 直呼びが無いこと**（ESLint が強制）

### Unit Tests（該当箇所のみ）

```bash
npx vitest run src/detect
```

EXPECT: 全通過

### Full Test Suite

```bash
npm run test
```

EXPECT: 既存 149 件を含めて全通過（回帰なし）

### Coverage

```bash
npm run test -- --coverage
```

EXPECT: Statements 80% 以上（プロジェクト基準）。`src/detect/` は純粋関数のみのため 95% 以上を目指す

### Build

```bash
npm run build
```

EXPECT: 成功

### dist の配線検証（CLAUDE.md 必須）

```bash
cat dist/service-worker-loader.js && grep -o 'getURL("[^"]*")' dist/assets/*loader*.js
```

EXPECT: service worker ローダーと content script ローダーが**別々の正しいチャンク**を指す

### Manual Validation（実機）

- [ ] `dist/` を未パック拡張として読み込み直す
- [ ] `chrome://extensions` の service worker ログに `index merged:` が出る
- [ ] `detected N candidates` が出る（**初回は N=0 が正常**）
- [ ] DevTools → Application → Storage → Extension storage → Local に `candidates` キーがある
- [ ] **エラー欄に何も出ていない**（想定内の動作で warn / error を出していないこと）
- [ ] 手動スキャンを 2 回連続で実行し、2 回目は `scan skipped: feed unchanged` になる（枠を消費しない）
- [ ] **トレンドセットが更新された後**にスキャンし、`records:` が増えることを確認する
- [ ] **OQ-12**: 数日かけて蓄積し、候補が 1 件でも出るかを記録する

---

## Acceptance Criteria

- [ ] Task 1〜13 がすべて完了
- [ ] 検証コマンドがすべて通る
- [ ] `src/detect/` の 4 モジュールにテストがある
- [ ] 型エラー 0、lint エラー 0
- [ ] `logger.warn` / `logger.error` を新たに増やしていない
- [ ] `detectCandidates` が `ScanMode` を引数に取らない（判定ロジックが 1 本）
- [ ] 実アカウント名・実 item_id がテストフィクスチャに入っていない

## Completion Checklist

- [ ] 検出層が純粋関数だけで構成されている（storage も fetch も触らない）
- [ ] 日時のパース失敗が例外にならず、レコード単位で捨てられる
- [ ] マージが元のインデックスを破壊しない
- [ ] 閾値がすべて名前付き定数か `Settings` 由来（マジックナンバー無し）
- [ ] テストの `describe` / `it` が日本語で振る舞いを説明している
- [ ] **各テストについて、直した箇所を戻すと落ちることを確認した**
- [ ] PRD の Phase 5 を `complete` に更新した
- [ ] OQ-12 の観測結果を PRD に記録した（検出できた／できなかった、その条件）

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **OQ-12 が否定される**（ライトモードでは何も検出できない） | **中** | **高** | Phase 5 の成果物自体は無駄にならない（フルモードで機能する）。否定された場合は PRD を改訂し、ライトモードの位置づけを「フルモードへの導線」に格下げする。**閾値を下げて無理に検出しない** — 適合率 80% が唯一の指標であり、誤検知は正当な著者を巻き添えにする |
| 蓄積が進まず候補が出ない状態が長く続く | 高 | 中 | ログに蓄積状況（レコード数・パージ数）を出し、「壊れている」との誤認を防ぐ。定期実行を持たない設計の必然的な帰結であり、バグではない |
| `storage.local` の 10 MB 上限に達する | 低 | 中 | 7 日でパージ。1 スキャン約 600 レコード × 6 セット ≒ 3600 レコードで、1 レコード約 200 バイトとして約 0.7 MB。余裕がある |
| クラスタ判定の計算量が service worker を止める | 低 | 中 | 記事 30 × アカウント 600 の素直な二重ループ。最適化しない。フルモードで記事が増えたら再検討 |
| **手順 4 の絞り込みを実装し忘れる** | 中 | 高 | 誤検知の入口。「手順 3 は通るが手順 4 で落ちる」テストを必ず書き、**絞り込みを外すと落ちること**を確認する |
| `Date` のパース失敗が `NaN` として静かに伝播する | 中 | 中 | `toEpochMs` が `null` を返す形に統一し、`Number.isNaN` を各所に散らさない |

## Notes

### この計画が触らないもの

orch-review が出した advisory（`QtgError` の `code` 化）は**この計画に含めない**。Phase 5 は `QtgError` を投げも捕まえもしないため、混ぜると変更の理由が 2 つになる。

### 記事化の素材になりうる点

CLAUDE.md の「目的 2」に関わるため記録しておく。

- **「N 人が M 本に共通」を素直に実装すると誤検知する。** 手順 3 だけでは「別々の 5 人がそれぞれ 2 本ずつ」を拾ってしまい、「同じ顔ぶれが揃う」という証拠の本質を捉えられない。2 段階の絞り込みが要る
- **ライトモードは 1 スキャンでは原理的に発火しない。** 30 件のトレンドに同一著者が 2 本入ることが稀という、実装前には見えにくい制約。蓄積という別の仕組みが要ることが設計を追ってはじめて分かる
- **定期実行を捨てた判断が、ここで蓄積速度という形で跳ね返ってくる。** レート枠を守る判断と、検出に必要なデータ量が正面から衝突する

### 実装順序の推奨

`like-index` → `cluster` → `burst` → `detector` → `storage` → `scanner` の順。**下から積む。**各段でテストを通してから次へ進むこと。`detector` まで出来た時点で、実機なしに OQ-12 の単体テストによる再現ができる。
