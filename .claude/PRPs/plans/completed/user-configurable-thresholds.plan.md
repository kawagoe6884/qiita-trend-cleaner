# Plan: 判定基準をユーザーに開放する（Phase 9）

## Summary

「投稿直後」とみなす幅（既定 60 分）とその閾値（既定 0% = 無効）を `Settings` に開放し、評価が済んだ候補を折りたたむ表示設定（既定なし）を `storage.local` に足す。**既定値はすべて現状維持なので、アップデートしても候補の見え方は 1 件も変わらない。**

開発者が実データで閾値を追い込む方針を撤回した結果のフェーズである。**新しい判定軸は 1 つも作らない。** 既にある `burstScore` の窓とフィルタをユーザーの手に渡すだけ。

## User Story

As a Qiita のトレンドを読む人、
I want 何を「投稿直後の集中」とみなすか、どこから候補にするかを自分で決めたい、
So that 自分の基準で絞り込み、その結果が当たっていたかを適合率で確かめられる。

## Problem → Solution

| | |
|---|---|
| **現在** | `BURST_WINDOW_MINUTES = 60` はソースの定数で、`burstScore` は**表示と並び順のタイブレークにしか使われていない**。ユーザーは何も調整できず、候補の件数を変える手段は `minClusterSize` / `minSharedItems` / `lookbackDays` の 3 本しかない |
| **目標** | 窓の幅と閾値をスライダーで決められる。評価が済んだものは折りたたんで視界から外せる（既定は外さない）。**適合率がユーザー自身の調整結果を見る計器になる** |

## Metadata

- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/qiita-trend-cleaner.prd.md`（改訂 6・Phase 9）
- **PRD Phase**: Phase 9 判定基準をユーザーに開放する
- **Estimated Files**: 実装 7 / テスト 5 / ドキュメント 2 = **14 ファイル**
- **Depends**: Phase 8（complete）

---

## ユーザー確定事項（2026-08-25）

逐語で確認済み。**推測で広げないこと。**

| # | 質問 | 回答 |
|---|---|---|
| A | 「投稿直後の集中」の扱い | 「認識と違う。**60 分 120 分 180 分のような設定値**と考えていた」→ 幅そのものを開放する |
| B | 折りたたみの選択肢 | 「**なしを追加して 4 項目選択肢、デフォルトなし**」 |
| C | 折りたたみは既存の非表示を置き換えるか | 「**置き換える**」（＝ポップアップの一覧での話。トレンドページの DOM 非表示は Phase 7 のまま） |
| D | 空アカウント率・組織名 | 「**開放しない**」 |
| E | 既定値 | 「**今までの既定値を維持して②**」（② = 幅と閾値を別項目にする案） |

**②を選んだ意味**: 幅（9a）だけを開放しても**候補の件数は 1 件も変わらない**。`burstScore` はフィルタに使われていないため。件数を動かすには閾値（9b）が要る。だから 2 項目。

---

## UX Design

### Before

```
┌─ Qiita Trend Guard ────────────────────────┐
│ フルモードで動作中                          │
│                                            │
│ 候補 3 件 / 適合率 —（未評価）              │
│ ▸ 判定の条件（5 アカウントが 2 記事に共通 / │
│              直近 7 日）                    │
│ ☐ 「妥当」と同時に Qiita 側でもミュートする │
│                                            │
│ ┌────────────────────────────────────────┐ │
│ │ example-author-a                       │ │
│ │ 9 アカウントが 2 記事に共通             │ │
│ │ 投稿直後の集中 0.97 / 空アカウント 0.25 │ │← 何分の話か読めない
│ │ 根拠: 記事1 記事2                       │ │
│ │ [妥当] [誤り]                           │ │
│ └────────────────────────────────────────┘ │
│ ┌ example-author-b（評価済み・ミュート済み）┐│← 済んだものが居座る
│ └────────────────────────────────────────┘ │
└────────────────────────────────────────────┘
```

### After

```
┌─ Qiita Trend Guard ────────────────────────┐
│ フルモードで動作中                          │
│                                            │
│ 候補 3 件 / 適合率 —（未評価）              │
│ ▾ 判定の条件（5 アカウントが 2 記事に共通 / │
│   直近 7 日）                               │
│    何アカウントそろったら  ──●──────  5     │
│    何記事に共通していたら  ─●───────  2     │
│    さかのぼる日数          ───────●  7     │
│    投稿直後とみなす幅      ●───────  60 分  │← 9a 新設（既定 60）
│    投稿直後の集中の下限    ●───────  無効   │← 9b 新設（既定 0 = 無効）
│                                            │
│ ☐ 「妥当」と同時に Qiita 側でもミュートする │
│ 評価が済んだものは [そのまま一覧に出す  ▾] │← 9c 新設（既定なし）
│                                            │
│ ┌────────────────────────────────────────┐ │
│ │ example-author-a                       │ │
│ │ 9 アカウントが 2 記事に共通             │ │
│ │ 投稿から 60 分以内の集中 0.97 /         │ │← 幅を文言に出す
│ │ 空アカウント 0.25                       │ │
│ │ 根拠: 記事1 記事2   [妥当] [誤り]       │ │
│ └────────────────────────────────────────┘ │
│                                            │
│ ▸ ミュート済み 2 件                        │← 9c で選んだときだけ出る
└────────────────────────────────────────────┘
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 判定の条件（`<details>`） | スライダー 3 本 | **5 本** | 追加分も既存と同じ input / change の二段構え |
| 候補のスコア行 | 「投稿直後の集中 0.97」 | 「投稿から **60 分**以内の集中 0.97」 | 幅が可変になった以上、数字だけでは意味が読めない |
| 折りたたみの選択 | 無い | `<select>` 4 択 | **判定の条件（`<details>`）の中に入れない。** 表示の設定なので混ぜない |
| 評価済みの候補 | 一覧に残る | 選べば `<details>` の中へ | **中でも「誤り」が押せる。** 押せば一覧に戻り、トレンドページの非表示も解ける |
| 条件の見出し | 「…／ 直近 7 日）」 | 閾値が **有効なときだけ** 「／ 投稿 60 分以内の集中 30% 以上」を足す | 無効（0）のときは出さない。ノイズになる |
| バッジ | 候補件数 | **変更なし** | 折りたたみは表示の設定。バッジを書くのは service worker で、表示設定を知る筋合いがない（AD-6） |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/detect/burst.ts` | 1-67 | `BURST_WINDOW_MINUTES` と `burstScore`。**ファイル冒頭の「補強スコアであって判定条件ではない」という記述は、このフェーズで書き換える対象** |
| P0 | `src/detect/detector.ts` | 49-85 | `burstScore` の呼び出しと `sort`。フィルタの挿入点 |
| P0 | `src/lib/storage.ts` | 91-119 | `asPositiveInt` と `getSettings`。**`asPositiveInt` は 0 を弾く** |
| P0 | `src/types/domain.ts` | 173-195 | `Settings` / `DEFAULT_SETTINGS` |
| P0 | `src/ui/popup/popup-page.ts` | 36-65, 210-343 | `SELECTORS` / `RANGES` / `renderCandidates` / `readSettings` / デバウンスと直列化 |
| P0 | `src/ui/popup/popup-state.ts` | 84-104, 156-167, 197-263 | `toViews` / `describeEmpty` / `loadPopupState` / `applySettings` |
| P1 | `src/ui/popup/index.html` | 6-186, 200-241 | CSS と要素の順序。**`body { min-height: 569px }` は実測で校正済み。触らない** |
| P1 | `src/dom/hider.ts` | 1-70 | 折りたたみとの関係。**hider は `candidates` ではなく `feedback` を見る**（AD-5） |
| P1 | `src/lib/badge.ts` | 1-30 | バッジの優先順位。折りたたみを載せない理由（AD-6） |
| P2 | `src/ui/popup/popup-page.test.ts` | 396-436, 571-600, 707-720 | レイアウト順序・丸め・スクロールバーのテスト。**実ファイルの HTML に対して固定している** |
| P2 | `src/lib/storage.test.ts` | 206-250 | `getSettings` の検証テスト。項目を足すときの形 |

## External Documentation

外部調査は不要。**すべて内部の既存パターンで完結する。**

| Topic | 判断 |
|---|---|
| `chrome.storage.sync` の書き込み上限 | 既知（1800 writes/hour）。PRD の実測表にあり、デバウンス 250ms は既にその対策 |
| `<details>` / `<select>` の挙動 | 標準要素。jsdom も `open` / `value` を持つ |
| 変異テスト | このプロジェクトの標準ゲート。外部ツールは使わない（手で戻して落ちることを確認する） |

---

## Architecture Decisions（実装前に必ず読む）

### AD-1 — `asPositiveInt` を `minBurstScore` に流用しない ★最重要

```ts
// SOURCE: src/lib/storage.ts:91-93
function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
```

`minBurstScore` の既定は **0**。`asPositiveInt(0) ?? DEFAULT_SETTINGS.minBurstScore` は `null ?? 0` = `0` なので、**今日は偶然正しく動く**。

**だが既定を 20 に変えた瞬間、ユーザーが明示的に 0（無効）にした設定が黙って 20 に巻き戻る。** 「無効にしたのに候補が減った」という、エラーが 1 行も出ない不具合になる。

0 を許す検証関数を**別に作る**:

```ts
/**
 * 0 以上の整数。**asPositiveInt と分ける。**
 *
 * minBurstScore の 0 は「無効」という有効な設定値であり、壊れた値ではない。
 * asPositiveInt に通すと null になり既定値へ倒れる。既定が 0 の今は
 * 結果が一致するので**偶然動く**が、既定を変えた瞬間にユーザーの 0 が
 * 黙って巻き戻る。**エラーは 1 行も出ない。**
 */
function asNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
```

### AD-2 — フィルタは `detector.ts` に置く。ポップアップに置かない

`detectCandidates` は **scanner.ts も呼ぶ**:

```ts
// SOURCE: src/background/scanner.ts:320-322
const settings = await storage.getSettings();
const candidates = detectCandidates(kept, settings, now);
await storage.saveCandidates(candidates);
```

ポップアップ側だけで絞ると、スキャン直後のバッジは絞る前の件数を出し、`storage.candidates` にも絞る前が入る。**同じ設定に対して 2 つの答えができる。** 絞り込みは検出の一部として `detector.ts` に置き、`sort` の**直前**に挟む。

### AD-3 — `coAuthors` はフィルタで作り直さない

```ts
// SOURCE: src/detect/detector.ts:61-63
// coAuthors は cross-cluster.ts が **連結成分ごとに** 決める。ここで
// 全 hit から作り直すと、独立した組織どうしを結び付けてしまう
const coAuthors = new Map(crossHits.map((hit) => [hit.authorHandle, hit.coAuthors]));
```

閾値で著者 A が落ちても、著者 B の `coAuthors` に A は**残す**。

- 落とすには連結成分の再計算が要り、上の警告に正面から反する
- **文言は嘘にならない。**「同じ顔ぶれが A の記事にも現れています」は、A の burstScore が閾値未満でも事実として成り立つ。以前レビューが捕まえた「重なりゼロの著者を挙げる」欠陥とは別物

**テストで固定する**（将来の「親切な修正」を止めるため）。

### AD-4 — `burstWindowMinutes` の既定は `DEFAULT_SETTINGS` を単一の出所にする

`BURST_WINDOW_MINUTES = 60` と `DEFAULT_SETTINGS.burstWindowMinutes = 60` を並べて書くと、片方だけ直す事故が必ず起きる。`burst.ts` から `domain.ts` を**値として** import する:

```ts
// burst.ts
import { DEFAULT_SETTINGS } from '../types/domain';
export const BURST_WINDOW_MINUTES = DEFAULT_SETTINGS.burstWindowMinutes;
```

`domain.ts` は `detect/` を一切 import しないので**循環しない**（現状 `burst.ts` は既に `../types/domain` から型を import している）。

### AD-5 — 折りたたみは Phase 7 の DOM 非表示と競合しない

```ts
// SOURCE: src/dom/hider.ts:7, 61-64
// candidates ではなく feedback を見る。閾値を動かすと候補は再計算で作り直されるが、
export function hideJudgedAuthors(feedback: FeedbackLog, root: ParentNode = document)
```

- トレンドページの非表示は `feedback === 'valid'` で決まる。**候補が閾値で消えても、隠れたままになる**（正しい。評価は取り消されていない）
- ポップアップの折りたたみは表示のみ。storage も content script も触らない
- **折りたたみの中で「誤り」を押すと `feedback` が変わり、トレンドページの記事が戻る。** これが OQ-16（誤検知の回収）の経路そのもの。**だから折りたたみの中でもボタンが押せなければならない**

### AD-6 — バッジは変えない

```
// SOURCE: src/lib/badge.ts:7
//   429 中 > 候補件数 > 空
```

バッジを書くのは scanner（service worker）。折りたたみは**ポップアップの表示設定**で `storage.local` にある。scanner に読ませると、表示設定が背景処理の出力を変えることになる。

「バッジ 5・一覧 0 件」に見える状況は起きうるが、そのとき `<details>` の見出しに「評価済み 5 件」と出ているので、**どこへ行ったかは画面上で分かる**。

### AD-7 — 折りたたみの判定に `mutedAt` を使う。`outcome` を使わない

```ts
// SOURCE: src/types/domain.ts:121-132（MuteRecord.mutedAt の JSDoc）
// **ミュートすると Qiita がその著者の記事をトレンドから外す**（2026-08-24 実機）。
// そのあと同じ候補で「妥当」を押し直すと、カードが無いので `not-on-page` になる。
```

`outcome === 'muted'` で判定すると、**押し直した瞬間に「ミュート済み」から外れて折りたたみから飛び出す**。`mutedAt !== undefined`（一度でも成功した）で見ること。Phase 8 が同じ罠を踏んで `mutedAt` を足した。

### AD-8 — 折りたたみの変更で再検出しない

`applySettings` は storage 全体を 2 回読み、300 アカウントの検出を回し、sync と local に書く。折りたたみは**手元の配列を 2 つに分けるだけ**なので、これを呼んではいけない。

```
スライダー変更 → applySettings（保存 + 再検出 + 再描画）
折りたたみ変更 → saveFoldTarget（local へ 1 回書く）+ 再描画のみ
```

---

## Patterns to Mirror

### NAMING_CONVENTION（配列から型を導出する）

```ts
// SOURCE: src/types/domain.ts:99-116
export const MUTE_OUTCOMES = ['muted', 'not-on-page', /* … */] as const;
export type MuteOutcome = (typeof MUTE_OUTCOMES)[number];

export function isMuteOutcome(value: unknown): value is MuteOutcome {
  return typeof value === 'string' && (MUTE_OUTCOMES as readonly string[]).includes(value);
}
```

`FoldTarget` も**そのまま同じ形**にする。storage から読んだ値の検証に型ガードが要るため。

### REPOSITORY_PATTERN（storage — 局所的に既定値へ倒す）

```ts
// SOURCE: src/lib/storage.ts:163-170
export async function getMuteOnValid(): Promise<boolean> {
  const raw = await readRaw();
  return raw.muteOnValid === true;
}

export async function saveMuteOnValid(muteOnValid: boolean): Promise<void> {
  await chrome.storage.local.set({ muteOnValid });
}
```

`getFoldTarget` / `saveFoldTarget` はこの 2 本の形をなぞる。**`local` に置く**（`muteOnValid` と同じ理由 — 判定に関係しない）。

### SERVICE_PATTERN（popup-state — DOM を触らない純粋関数）

```ts
// SOURCE: src/ui/popup/popup-state.ts:151-154
export function describeCoAuthors(coAuthors: AccountHandle[] | undefined): string {
  if (coAuthors === undefined || coAuthors.length === 0) return '';
  return `同じ顔ぶれが ${coAuthors.join('、')} の記事にも現れています。`;
}
```

**「無ければ空文字を返し、呼び出し側が行ごと出さない」** が既存の規約。`describeFold` / `foldNote` もこれに合わせる。

### 表示は同期・保存は非同期（スライダーの二段構え）

```ts
// SOURCE: src/ui/popup/popup-page.ts:506-516
for (const selector of [SELECTORS.minCluster, SELECTORS.minShared, SELECTORS.lookback]) {
  const input = find<HTMLInputElement>(selector);
  input?.addEventListener('input', () => { previewSettings(); });     // 同期処理だけ
  input?.addEventListener('change', () => { scheduleApply(); });      // 250ms デバウンス + 直列
}
```

**配列に 2 本足すだけ。** ループの中身は一切変えない。ここに非同期を 1 つ足すと Phase 6 で潰した「つまみが指の下から逃げる」が戻る。

### TEST_STRUCTURE（AAA・実アカウント名を使わない）

```ts
// SOURCE: src/detect/burst.test.ts:43-51
it('全員が投稿直後なら 1.0', () => {
  // Arrange
  const index: LikeIndex = {
    'example-liker-1': entry([record(1, 10), record(2, 10)]),
    'example-liker-2': entry([record(1, 5), record(2, 5)]),
  };
  // Act & Assert
  expect(burstScore(index, HIT)).toBe(1);
});
```

ハンドルは `example-author-*` / `example-liker-*`、記事 ID は `0123456789abcdef0001` 形式。**実データを 1 件も持ち込まない**（記事化の絶対制約）。

### TEST_STRUCTURE（実 HTML に対する順序の固定）

```ts
// SOURCE: src/ui/popup/popup-page.test.ts:9, 399-407
import indexHtml from './index.html?raw';

const conditions = indexHtml.indexOf('id="conditions"');
const list = indexHtml.indexOf('id="candidates"');
expect(conditions).toBeLessThan(list);
```

`setupDom()` は骨格のモックなので、**順序は実ファイルに対して検査する**。要素を足したら `setupDom()` にも足すこと（足さないと新しい要素が取れず、テストが「要素が無いので何もしない」経路を通って**通ってしまう**）。

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/types/domain.ts` | UPDATE | `Settings` に 2 項目 / `DEFAULT_SETTINGS` / `FoldTarget` 一式 / `LocalState.foldTarget` |
| `src/detect/burst.ts` | UPDATE | `BURST_WINDOW_MINUTES` の出所を変更 / `burstScore` に `windowMinutes` 引数 / 冒頭 JSDoc の書き換え |
| `src/detect/detector.ts` | UPDATE | 窓を渡す / `sort` の直前に閾値フィルタ |
| `src/lib/storage.ts` | UPDATE | `asNonNegativeInt` 新設 / `getSettings` に 2 項目 / `getFoldTarget` / `saveFoldTarget` |
| `src/ui/popup/index.html` | UPDATE | スライダー 2 本 / `<select>` / `<details id="folded">` / `.slider` の桁幅 |
| `src/ui/popup/popup-state.ts` | UPDATE | `partitionViews` / `describeFold` / `foldNote` / `describeScores` / `describeBurstThreshold` / `describeEmpty` 拡張 / `loadPopupState` に `foldTarget` |
| `src/ui/popup/popup-page.ts` | UPDATE | `SELECTORS` / `RANGES` / `readSettings` のガード / `renderCandidates` の分割 / `<select>` のリスナー / `describeConditions` |
| `src/detect/burst.test.ts` | UPDATE | 可変の窓のテスト |
| `src/detect/detector.test.ts` | UPDATE | 閾値フィルタ・既定が素通しであること・`coAuthors` を作り直さないこと |
| `src/lib/storage.test.ts` | UPDATE | 新項目の検証・**0 が既定値に倒れないこと**・`foldTarget` |
| `src/ui/popup/popup-state.test.ts` | UPDATE | `partitionViews` / `describeFold` / `foldNote` / `describeScores` |
| `src/ui/popup/popup-page.test.ts` | UPDATE | `setupDom()` 更新 / スライダー 2 本 / 折りたたみの操作 / レイアウト順序 |
| `.claude/PRPs/prds/qiita-trend-cleaner.prd.md` | UPDATE | Phase 表を complete に |
| `CLAUDE.md` | UPDATE | 現在地の表 / 教訓 |

## NOT Building

- **空アカウント率（`emptyAccountRatio`）の開放。** 実測で手口を素通りし、しかも共通 17 人を 6%（全体 38%）と**より健全に見せた**（OQ-15）。善意で「50% 以上」にした人が実在の手口を取りこぼす
- **組織名・組織リンク・いいね数の開放（OQ-20）。** 特定企業を狙い撃ちする機能になる
- **判定軸の追加。** 既存の 2 本（著者内クラスタ・著者間クラスタ）は一切触らない
- **`emptyAccountRatio` を並び順に入れること。** `sort` は `clusterSize` → `burstScore` のまま
- **設定のプリセット / インポート / エクスポート。** YAGNI
- **折りたたみの中で「妥当」を押せること。** 押せるが、既に妥当なので何も変わらない。**専用の扱いは作らない**
- **バッジの変更**（AD-6）
- **トレンドページ側の DOM 非表示の変更。** Phase 7 のまま（AD-5）
- **`chrome.storage.sync` のマイグレーション。** `getSettings` はフィールド単位で既定値へ倒すので、旧い保存値（3 項目）はそのまま読める

---

## Step-by-Step Tasks

### Task 1: `types/domain.ts` に設定 2 項目と折りたたみの型を足す

- **ACTION**: `Settings` を 5 項目にし、`DEFAULT_SETTINGS` を更新。`FoldTarget` 一式と `LocalState.foldTarget` を追加
- **IMPLEMENT**:

```ts
/** storage.sync に置く設定。アクセストークンは含めない */
export interface Settings {
  minClusterSize: number;
  minSharedItems: number;
  lookbackDays: number;
  /**
   * 「投稿直後」とみなす幅（分）。**判定の入力なので Settings に置く。**
   *
   * 何を「投稿直後の集中」と見るかは読む人によって違う。開発者が 1 つの
   * 正解を決めて追い込むより、決めてもらった方が正しい（PRD 改訂 6）。
   */
  burstWindowMinutes: number;
  /**
   * 候補にする burstScore の下限（**百分率の整数 0-100**）。
   *
   * **0 は「無効」という有効な設定値。** 壊れた値ではないので
   * asPositiveInt に通してはいけない（storage.ts の asNonNegativeInt）。
   *
   * 百分率にしてあるのはスライダーが整数しか出さないため。判定側では
   * `burstScore * 100 >= minBurstScore` と比べる。
   */
  minBurstScore: number;
}

/**
 * 既定値は **フルモード前提**（改訂 6 以降）。
 *
 * （既存の lookbackDays に関する記述はそのまま残す）
 *
 * **burstWindowMinutes と minBurstScore の既定は現状維持。**
 * 60 分は Phase 5 から使っている値、0 は「絞り込まない」＝これまでの挙動。
 * **アップデートで候補の見え方が変わってはいけない。**
 */
export const DEFAULT_SETTINGS: Settings = {
  minClusterSize: 5,
  minSharedItems: 2,
  lookbackDays: 7,
  burstWindowMinutes: 60,
  minBurstScore: 0,
};

/**
 * ポップアップの一覧で折りたたむ対象。**表示の設定であって判定ではない。**
 *
 * | 値 | 意味 |
 * |---|---|
 * | `none` | 折りたたまない（**既定**） |
 * | `muted` | 一度でもミュートに成功した著者だけ |
 * | `valid` | 「妥当」と評価した著者だけ |
 * | `judged` | 「妥当」「誤り」いずれかを評価した著者すべて |
 *
 * **既定が none なのは、視界から消す方向の変更だから。**
 * 誤検知でミュートしたアカウントを再評価できなくする失敗（OQ-16）と
 * 同じ形を持つ。折りたたんだ中でも「誤り」が押せることで回収経路を残す。
 */
export const FOLD_TARGETS = ['none', 'muted', 'valid', 'judged'] as const;

export type FoldTarget = (typeof FOLD_TARGETS)[number];

export function isFoldTarget(value: unknown): value is FoldTarget {
  return typeof value === 'string' && (FOLD_TARGETS as readonly string[]).includes(value);
}
```

`LocalState` に追加:

```ts
  /**
   * 評価が済んだ候補を折りたたむ対象。**既定は 'none'。**
   *
   * Settings（sync）に入れないのは、あれが detectCandidates の入力だから。
   * これは表示の設定で判定に一切関与しない（muteOnValid と同じ扱い）。
   */
  foldTarget?: FoldTarget;
```

- **MIRROR**: NAMING_CONVENTION（`MUTE_OUTCOMES` / `isMuteOutcome`）
- **IMPORTS**: なし（`domain.ts` は何も import しない）
- **GOTCHA**: **JSDoc と宣言のあいだに新しい宣言を挿入しない。** このプロジェクトで 4 回起きた事故。`FOLD_TARGETS` は `MuteOutcome` 群の**後ろ**、`Candidate` の前に置く。書いたら `git diff` を目で追う
- **VALIDATE**: `npx --no-install tsc --noEmit` が 0 errors。`DEFAULT_SETTINGS` の 5 項目が揃っている

### Task 2: `detect/burst.ts` の窓を引数にする

- **ACTION**: `BURST_WINDOW_MINUTES` の出所を `DEFAULT_SETTINGS` に移し、`burstScore` に `windowMinutes` 引数を足す
- **IMPLEMENT**:

冒頭 JSDoc の書き換え（**「Phase 9 で調整する」はもう過去形**）:

```ts
/**
 * バーストスコアと空アカウント指標。
 *
 * この層は純粋関数だけで構成する（storage も fetch も触らない）。
 *
 * 【burstScore は Phase 9 で判定条件になった】
 * 幅（Settings.burstWindowMinutes）と下限（Settings.minBurstScore）を
 * ユーザーが決める。**下限の既定は 0 = 無効**なので、既定のままなら
 * これまでどおり記録と並び順のタイブレークにしか効かない。
 *
 * 【emptyAccountRatio は開放しない】
 * 実測でユーザーが目視で見つけた 2 著者の共通 17 人は空率 6%、
 * インデックス全体は 38% だった。**手口を素通りしただけでなく、より
 * 健全に見せた**（OQ-15）。閾値として出すと、善意で上げた人が
 * 実在の手口を取りこぼす。記録と表示に留める。
 */
import { DEFAULT_SETTINGS } from '../types/domain';
import { toEpochMs } from './like-index';
import type { AccountHandle, LikeIndex } from '../types/domain';
import type { ClusterHit } from './cluster';

/**
 * 「投稿直後」とみなす幅の**既定値**。
 *
 * **DEFAULT_SETTINGS から導出する。**2 箇所に 60 と書くと、片方だけ直す
 * 事故が必ず起きる。domain.ts は detect/ を import しないので循環しない。
 */
export const BURST_WINDOW_MINUTES = DEFAULT_SETTINGS.burstWindowMinutes;
```

`burstScore` の署名と 1 行:

```ts
export function burstScore(
  index: LikeIndex,
  hit: ClusterHit,
  windowMinutes: number = BURST_WINDOW_MINUTES,
): number {
  const shared = new Set(hit.sharedItemIds);
  const windowMs = windowMinutes * MS_PER_MINUTE;
  // …以下は一切変更しない
```

- **MIRROR**: 既存の `emptyAccountRatio` と同じ純粋関数の形
- **IMPORTS**: `import { DEFAULT_SETTINGS } from '../types/domain';`（値の import を 1 本追加）
- **GOTCHA**: **既定引数を必ず残す。** 残せば `burst.test.ts` の既存 9 ケースが**無改変で通る**。通らなくなったら、それは引数の順序か既定値を間違えている合図
- **VALIDATE**: `npx vitest run src/detect/burst.test.ts` が既存のまま全通過

### Task 3: `detect/detector.ts` に窓を渡し、閾値で絞る

- **ACTION**: `burstScore` に `settings.burstWindowMinutes` を渡し、`sort` の**直前**に `filter` を挿入
- **IMPLEMENT**:

```ts
      burstScore: burstScore(scoped, hit, settings.burstWindowMinutes),
```

```ts
  // 怪しい順に並べる。Phase 6 の一覧はこの順で出す
  //
  // 【絞り込みは sort の前】
  // minBurstScore は **百分率の整数**。既定 0 では burstScore >= 0 が常に
  // 真なので **1 件も減らない**（アップデートで見え方が変わらないこと）。
  //
  // ここで絞るのは、scanner も detectCandidates を呼ぶため（AD-2）。
  // ポップアップ側だけで絞ると、バッジと storage.candidates が
  // 絞る前の件数を持ち、同じ設定に 2 つの答えができる。
  //
  // **coAuthors は作り直さない**（AD-3）。閾値で落ちた著者も、同じ顔ぶれが
  // その記事に現れたことは事実として変わらない。作り直すと連結成分の
  // 再計算が要り、独立した組織どうしを結び付ける欠陥に戻る。
  return candidates
    .filter((candidate) => candidate.burstScore * 100 >= settings.minBurstScore)
    .sort((a, b) => b.clusterSize - a.clusterSize || b.burstScore - a.burstScore);
```

- **MIRROR**: 既存の `detectCandidates` の構造（フィルタ → 判定 → スコア → 並べ替え）
- **IMPORTS**: 変更なし
- **GOTCHA**: `burstScore * 100` は浮動小数。`0.3 * 100 === 30.000000000000004` なので `>= 30` は通る。**境界のテストを必ず書く**（burstScore 0.3 / 閾値 30 → 含まれる）。`Math.round` で丸めないこと — 29.5% を 30% 扱いにしてしまう
- **VALIDATE**: `npx vitest run src/detect/detector.test.ts`。既定値（`DEFAULT_SETTINGS`）を使う既存テストがすべて無改変で通ること（**通らなければ既定が現状維持になっていない**）

### Task 4: `lib/storage.ts` に検証関数と折りたたみの入口を足す

- **ACTION**: `asNonNegativeInt` を新設、`getSettings` に 2 項目、`getFoldTarget` / `saveFoldTarget` を追加
- **IMPLEMENT**:

```ts
/**
 * 0 以上の整数。**asPositiveInt と分ける。**
 *
 * minBurstScore の 0 は「無効」という有効な設定値であり、壊れた値ではない。
 * asPositiveInt に通すと null になり既定値へ倒れる。既定が 0 の今は
 * 結果が一致するので**偶然動く**が、既定を変えた瞬間に
 * **ユーザーが明示的に 0 にした設定が黙って巻き戻る。**
 * エラーは 1 行も出ない。
 */
function asNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
```

`getSettings` の戻り値に 2 行追加（**既存 3 行は変更しない**）:

```ts
    burstWindowMinutes:
      asPositiveInt(candidate.burstWindowMinutes) ?? DEFAULT_SETTINGS.burstWindowMinutes,
    minBurstScore: asNonNegativeInt(candidate.minBurstScore) ?? DEFAULT_SETTINGS.minBurstScore,
```

折りたたみの入口（`getMuteOnValid` / `saveMuteOnValid` の直後に置く）:

```ts
/**
 * 評価が済んだ候補を折りたたむ対象。**既定は 'none'（折りたたまない）。**
 *
 * local に置くのは muteOnValid と同じ理由 — Settings（sync）は
 * detectCandidates の入力であり、表示の設定を混ぜない。
 *
 * 知らない値は 'none' に倒す。通すと UI の switch が文言を返せずに落ちる
 * （getMuteLog が知らない outcome を落とすのと同じ）。
 */
export async function getFoldTarget(): Promise<FoldTarget> {
  const raw = await readRaw();
  return isFoldTarget(raw.foldTarget) ? raw.foldTarget : 'none';
}

export async function saveFoldTarget(foldTarget: FoldTarget): Promise<void> {
  await chrome.storage.local.set({ foldTarget });
}
```

- **MIRROR**: REPOSITORY_PATTERN（`getMuteOnValid` / `saveMuteOnValid`）
- **IMPORTS**: 値: `import { DEFAULT_SETTINGS, isFoldTarget, isMuteOutcome } from '../types/domain';` / 型: `FoldTarget` を type import に追加
- **GOTCHA**: `asNonNegativeInt` を `asPositiveInt` の**すぐ下**に置く。JSDoc の孤立を作らないこと
- **VALIDATE**: `npx vitest run src/lib/storage.test.ts`。既存の「0 や負数・小数は既定値に倒す」テストが**通り続ける**こと（`minClusterSize` は依然 `asPositiveInt`）

### Task 5: `index.html` にスライダー 2 本・`<select>`・折りたたみの器を足す

- **ACTION**: 要素と最小限の CSS を追加
- **IMPLEMENT**:

`.slider` の桁幅（**「360 分」「無効」が入らないので広げる**）:

```css
      .slider {
        display: grid;
        /* 3 列目は出力。「360 分」と「無効」が入る幅が要る。
           2.5em では「360 分」が折り返す（既存 3 本は 2 桁なので影響なし） */
        grid-template-columns: 11em 1fr 4.5em;
        align-items: center;
        gap: 8px;
        font-size: 0.85rem;
      }
```

折りたたみの CSS:

```css
      /* 折りたたみの選択。**判定の条件（#conditions）の中に入れない** —
         あれは detectCandidates の入力で、こちらは表示の設定 */
      .fold-select {
        margin: 0 0 12px;
        font-size: 0.9rem;
      }
      .fold-select select {
        font-family: inherit;
        font-size: 0.9rem;
      }
      /* 評価が済んだ候補の置き場。**何も入っていないときは hidden。**
         display は指定しない（UA の [hidden]{display:none} に勝ってしまう） */
      #folded {
        border: 1px solid currentColor;
        border-radius: 8px;
        padding: 6px 12px;
        margin: 12px 0 0;
      }
      #folded[open] {
        padding-bottom: 12px;
      }
      #folded ul {
        list-style: none;
        margin: 8px 0 0;
        padding: 0;
      }
```

`#conditions` の中、`lookback` のスライダーの**後ろ**に 2 本:

```html
      <p class="slider">
        <label for="burst-window">投稿直後とみなす幅</label>
        <input type="range" id="burst-window" min="30" max="360" step="30" />
        <output id="burst-window-value"></output>
      </p>
      <p class="slider">
        <label for="min-burst">投稿直後の集中の下限</label>
        <input type="range" id="min-burst" min="0" max="100" step="10" />
        <output id="min-burst-value"></output>
      </p>
```

`#mute-note` の**後ろ**、`<ul id="candidates">` の**前**:

```html
    <p class="fold-select">
      <label for="fold-target">評価が済んだものは</label>
      <select id="fold-target">
        <option value="none">そのまま一覧に出す</option>
        <option value="muted">ミュート済みだけ折りたたむ</option>
        <option value="valid">「妥当」だけ折りたたむ</option>
        <option value="judged">評価済みをすべて折りたたむ</option>
      </select>
    </p>
```

`#empty` の**後ろ**（一覧の最後）:

```html
    <details id="folded" hidden>
      <summary id="folded-summary"></summary>
      <p class="footnote" id="fold-note" hidden></p>
      <ul id="folded-candidates"></ul>
    </details>
```

- **MIRROR**: 既存の `.slider` / `.mute-toggle` / `#conditions` の書き方
- **IMPORTS**: なし
- **GOTCHA**:
  - **`body { min-height: 569px }` を変えない。** 実測で校正済み（569 + padding 32 = 601 > 600）。今回の追加はすべて高さが**増える**方向なので条件は保たれる
  - `<details id="folded">` に `open` を付けない。付けると折りたたみの意味が消える
  - `hidden` を初期状態に付ける。中身が 0 件のときに空の器が出る
- **VALIDATE**: `npm run build` が通り、`dist/` に HTML が出る。`npm run format` でずれが出ないこと

### Task 6: `popup-state.ts` に折りたたみと文言を足す

- **ACTION**: `describeScores` を移設、`partitionViews` / `describeFold` / `foldNote` / `describeBurstThreshold` を新設、`describeEmpty` を拡張、`loadPopupState` に `foldTarget`
- **IMPLEMENT**:

```ts
/**
 * 候補 1 件のスコア行。**幅を文言に出す。**
 *
 * 幅が可変になった以上「投稿直後の集中 0.97」では数字の意味が読めない。
 * 60 分と 360 分では同じ 0.97 でも言っていることが違う。
 *
 * **popup-page.ts から移した。**幅を引数で受ける必要が出たので、
 * DOM を触らない層でユニットテストできる形にする。
 */
export function describeScores(candidate: Candidate, windowMinutes: number): string {
  return `投稿から ${String(windowMinutes)} 分以内の集中 ${candidate.burstScore.toFixed(2)} / 空アカウント ${candidate.emptyAccountRatio.toFixed(2)}`;
}

/**
 * 下限スライダーの表示。**0 は「無効」と言い切る。**
 *
 * 「0%」だと「0% 以上という閾値」なのか「絞り込まない」のか読めない。
 * 既定値なので、大半のユーザーが最初に見るのはこの表示になる。
 */
export function describeBurstThreshold(minBurstScore: number): string {
  return minBurstScore === 0 ? '無効' : `${String(minBurstScore)}%`;
}

export interface PartitionedViews {
  open: CandidateView[];
  folded: CandidateView[];
}

/**
 * 折りたたむものと出すものに分ける。**純粋関数。順序は保つ。**
 *
 * 【mutedAt で見る。outcome では見ない】
 * ミュートすると Qiita がその著者の記事をトレンドから外すので、押し直すと
 * 必ず `not-on-page` になる（MuteRecord.mutedAt の JSDoc）。outcome で
 * 判定すると、**押し直した瞬間に折りたたみから飛び出す。**
 *
 * 【'muted' でも「誤り」で外れない】
 * 「誤り」を押しても Qiita 側のミュートは解除されない。折りたたみに
 * 残るのは事実として正しい。解除の導線は foldNote が出す。
 */
export function partitionViews(views: CandidateView[], target: FoldTarget): PartitionedViews {
  const shouldFold = (view: CandidateView): boolean => {
    switch (target) {
      case 'none':
        return false;
      case 'muted':
        return view.mute?.mutedAt !== undefined;
      case 'valid':
        return view.verdict === 'valid';
      case 'judged':
        return view.verdict !== null;
    }
  };
  return {
    open: views.filter((view) => !shouldFold(view)),
    folded: views.filter(shouldFold),
  };
}

/**
 * 折りたたみの見出し。**0 件なら空文字を返し、器ごと出さない**
 * （describeCoAuthors と同じ規約）。
 */
export function describeFold(target: FoldTarget, count: number): string {
  if (target === 'none' || count === 0) return '';
  const label =
    target === 'muted' ? 'ミュート済み' : target === 'valid' ? '「妥当」と評価した' : '評価済み';
  return `${label} ${String(count)} 件`;
}

/**
 * 折りたたみの中の注意書き。**ミュート済みが 1 件でもあるときだけ出す。**
 *
 * 「誤り」を押しても Qiita 側のミュートは解除されない。折りたたみは
 * 「視界から消す」方向の変更なので、**誤検知でミュートしたアカウントを
 * 再評価できなくする**という既知の失敗（OQ-16）と同じ形を持つ。
 * 解除の導線をここに置くことがその歯止めになる。
 *
 * 1 件も無いときに出さないのは、'judged' で誰もミュートしていない場合に
 * 関係のない注意書きが出るのを避けるため。
 */
export function foldNote(folded: CandidateView[]): string {
  if (!folded.some((view) => view.mute?.mutedAt !== undefined)) return '';
  return 'ここで「誤り」を押しても、Qiita 側のミュートは解除されません。解除は 設定 > ミュート から行ってください。';
}
```

`describeEmpty` の拡張（**既定引数で既存の呼び出しを壊さない**）:

```ts
export function describeEmpty(hasIndex: boolean, foldedCount = 0): string {
  // 折りたたみの中に居るのに「条件をゆるめると増えます」と言うと、
  // 何もしていない人に条件をいじらせることになる
  if (foldedCount > 0) return '出ている候補はすべて折りたたみの中にあります。';
  return hasIndex
    ? 'いまの条件に当てはまる候補はありません。条件をゆるめると増えます。'
    : 'まだ何も集めていません。トレンドページを開くと蓄積が始まります。';
}
```

`PopupState` と `loadPopupState`:

```ts
  /** 評価が済んだ候補を折りたたむ対象。**既定は 'none'** */
  foldTarget: FoldTarget;
```

```ts
  const [candidates, feedback, settings, until, lastScan, hasToken, index, muteOnValid, muteLog, foldTarget] =
    await Promise.all([
      // …既存 9 本…
      storage.getFoldTarget(),
    ]);
  return {
    // …既存…
    foldTarget,
  };
```

- **MIRROR**: SERVICE_PATTERN（`describeCoAuthors` の「無ければ空文字」）
- **IMPORTS**: `import type { … Candidate, FoldTarget, … } from '../../types/domain';`
- **GOTCHA**:
  - `switch` に `default` を書かない。`FoldTarget` に値を足したとき TypeScript が漏れを教える（`describeMuteOutcome` と同じ）
  - `partitionViews` は `filter` を 2 回回すが、候補は多くて数十件。**module 変数に持たない**（`currentMuteLog` で踏んだ「1 つの事実に 2 つの置き場」を作らない）
  - **JSDoc と関数のあいだに別の宣言を挿入しない。** 4 回踏んでいる。`git diff` を目で追うこと
- **VALIDATE**: `npx vitest run src/ui/popup/popup-state.test.ts`

### Task 7: `popup-page.ts` を配線する

- **ACTION**: `SELECTORS` / `RANGES` を拡張、`readSettings` のガードを範囲基準に、`renderCandidates` を 2 分割、`<select>` のリスナー、`describeConditions` を拡張、`describeScores` を import に切り替え
- **IMPLEMENT**:

```ts
const SELECTORS = {
  // …既存…
  burstWindow: '#burst-window',
  minBurst: '#min-burst',
  burstWindowValue: '#burst-window-value',
  minBurstValue: '#min-burst-value',
  foldTarget: '#fold-target',
  folded: '#folded',
  foldedSummary: '#folded-summary',
  foldedList: '#folded-candidates',
  foldNote: '#fold-note',
} as const;

const RANGES = {
  minClusterSize: { min: 2, max: 30 },
  minSharedItems: { min: 2, max: 10 },
  lookbackDays: { min: 1, max: 7 },
  /** 30 分刻み。30 分未満は通知経由の正常な読者と区別がつかない */
  burstWindowMinutes: { min: 30, max: 360 },
  /** 百分率。**min は 0**（無効という有効な設定値） */
  minBurstScore: { min: 0, max: 100 },
} as const;
```

`readSettings` のガード（**`parsed <= 0` を捨てて範囲で判断する**）:

```ts
/**
 * スライダーの現在値。要素が取れなければ直前の値の側に倒す。
 *
 * **可動域に丸める。**（既存の理由はそのまま）
 *
 * 【`<= 0` で弾かない】
 * minBurstScore の 0 は「無効」という有効な設定値。正の数だけを通す形に
 * すると、無効にした瞬間に直前の値へ戻り、**スライダーが左端に行かない。**
 * 下限の判定は range.min に任せる（もともと最後に丸めている）。
 */
function readSettings(fallback: Settings): Settings {
  const read = (selector: string, current: number, range: { min: number; max: number }): number => {
    const input = find<HTMLInputElement>(selector);
    // 空文字は Number('') === 0 になる。range.min が 0 の項目で誤って
    // 0 と読まないよう、値が無い場合は現在値へ倒す
    if (input === null || input.value === '') return current;
    const parsed = Number(input.value);
    if (!Number.isInteger(parsed)) return current;
    return Math.min(Math.max(parsed, range.min), range.max);
  };
  return {
    minClusterSize: read(SELECTORS.minCluster, fallback.minClusterSize, RANGES.minClusterSize),
    minSharedItems: read(SELECTORS.minShared, fallback.minSharedItems, RANGES.minSharedItems),
    lookbackDays: read(SELECTORS.lookback, fallback.lookbackDays, RANGES.lookbackDays),
    burstWindowMinutes: read(
      SELECTORS.burstWindow,
      fallback.burstWindowMinutes,
      RANGES.burstWindowMinutes,
    ),
    minBurstScore: read(SELECTORS.minBurst, fallback.minBurstScore, RANGES.minBurstScore),
  };
}
```

`renderSliderInputs` / `renderSettingLabels` に 2 行ずつ追加:

```ts
  bind(SELECTORS.burstWindow, settings.burstWindowMinutes, RANGES.burstWindowMinutes);
  bind(SELECTORS.minBurst, settings.minBurstScore, RANGES.minBurstScore);
```

```ts
  setText(SELECTORS.burstWindowValue, `${String(settings.burstWindowMinutes)} 分`);
  setText(SELECTORS.minBurstValue, describeBurstThreshold(settings.minBurstScore));
```

`describeConditions`（**無効なときは足さない**）:

```ts
/**
 * 折りたたんだままでも現在の条件が読めるようにする。
 *
 * **下限が 0（無効）のときは書かない。**既定値なので大半の人に出ることになり、
 * 「30% 以上」と書くのと同じ長さの文字列がノイズとして常駐する
 */
function describeConditions(settings: Settings): string {
  const base = `${String(settings.minClusterSize)} アカウントが ${String(settings.minSharedItems)} 記事に共通 / 直近 ${String(settings.lookbackDays)} 日`;
  const burst =
    settings.minBurstScore === 0
      ? ''
      : ` / 投稿 ${String(settings.burstWindowMinutes)} 分以内の集中 ${String(settings.minBurstScore)}% 以上`;
  return `判定の条件（${base}${burst}）`;
}
```

`renderCandidates` を分割:

```ts
/**
 * 一覧を描く。**折りたたみの分割はここ 1 箇所で行う。**
 *
 * partitionViews は純粋関数なので、renderSummary 側でも呼び直す。
 * module 変数に開き件数を持たない — **1 つの事実に置き場を 2 つ作らない**
 * （currentMuteLog を消したのと同じ理由）。数十件の filter は 2 回回しても
 * 無視できる。
 */
function renderCandidates(views: CandidateView[]): void {
  const { open, folded } = partitionViews(views, currentFoldTarget);
  find<HTMLUListElement>(SELECTORS.candidates)?.replaceChildren(...open.map(candidateItem));
  find<HTMLUListElement>(SELECTORS.foldedList)?.replaceChildren(...folded.map(candidateItem));

  const heading = describeFold(currentFoldTarget, folded.length);
  setText(SELECTORS.foldedSummary, heading);
  setHidden(SELECTORS.folded, heading === '');

  const note = foldNote(folded);
  setText(SELECTORS.foldNote, note);
  setHidden(SELECTORS.foldNote, note === '');
}
```

`renderSummary` の `#empty` 判定:

```ts
  const { open, folded } = partitionViews(views, currentFoldTarget);
  setText(SELECTORS.empty, describeEmpty(currentHasIndex, folded.length));
  setHidden(SELECTORS.empty, open.length > 0);
```

`candidateItem` のスコア行:

```ts
    paragraph('scores', describeScores(view.candidate, currentSettings.burstWindowMinutes)),
```

`findCandidateItem` の探索範囲（**折りたたみの中も含める**）:

```ts
/**
 * 候補の行を著者ハンドルで引く。
 *
 * **セレクタ文字列を組み立てない。**（既存の理由はそのまま）
 *
 * **`#candidates` に限定しない。**折りたたみの中の行も対象。data-handle を
 * 持つのは候補の <li> だけなので、全体から拾って問題ない。
 */
function findCandidateItem(handle: string): HTMLLIElement | null {
  for (const item of document.querySelectorAll<HTMLLIElement>('li[data-handle]')) {
    if (item.dataset.handle === handle) return item;
  }
  return null;
}
```

リスナー（**クリック処理を括り出して 2 箇所に付ける**）:

```ts
/**
 * 候補の行のクリック。リンクなら背景タブ、判定ボタンなら記録。
 *
 * **括り出したのは、折りたたみの中の行にも同じ処理が要るため。**
 * 中で「誤り」が押せないと、誤検知でミュートしたアカウントを再評価できなく
 * なる（OQ-16 と同じ形）。折りたたみは視界から消す機能なので、回収経路を
 * 必ず残す。
 */
function handleCandidateAreaClick(event: MouseEvent): void {
  if (handleLinkClick(event)) return;
  const resolved = resolveVerdictTarget(event.target);
  if (resolved === null) return;
  handleVerdict(resolved.handle, resolved.verdict).catch((error: unknown) => {
    logger.error('failed to record verdict:', error);
  });
}
```

```ts
  // #folded には注意書きのリンク（設定 > ミュート）も入っている。
  // handleLinkClick が先に走るので 1 本で足りる
  for (const selector of [SELECTORS.candidates, SELECTORS.folded]) {
    find(selector)?.addEventListener('click', handleCandidateAreaClick);
  }

  for (const selector of [
    SELECTORS.minCluster,
    SELECTORS.minShared,
    SELECTORS.lookback,
    SELECTORS.burstWindow,
    SELECTORS.minBurst,
  ]) {
    // …中身は一切変えない…
  }

  // 折りたたみは表示だけの設定。**applySettings を呼ばない**（AD-8）——
  // storage 全体の読み込みも検出も sync への書き込みも要らない
  find<HTMLSelectElement>(SELECTORS.foldTarget)?.addEventListener('change', (event) => {
    const value: unknown = event.target instanceof HTMLSelectElement ? event.target.value : null;
    if (!isFoldTarget(value)) return;
    currentFoldTarget = value;
    renderCandidates(currentViews);
    renderSummary(currentViews, currentPrecision);
    saveFoldTarget(value).catch((error: unknown) => {
      logger.error('failed to save fold setting:', error);
    });
  });
```

module 変数と `init`:

```ts
/** 評価が済んだ候補を折りたたむ対象。**既定は 'none'** */
let currentFoldTarget: FoldTarget = 'none';
```

```ts
    currentFoldTarget = state.foldTarget;
    renderFoldSelect(state.foldTarget);
```

```ts
/** 保存済みの折りたたみ設定を <select> に映す。**init でだけ呼ぶ** */
function renderFoldSelect(target: FoldTarget): void {
  const select = find<HTMLSelectElement>(SELECTORS.foldTarget);
  if (select) select.value = target;
}
```

- **MIRROR**: `renderMuteToggle`（保存値を映すのは init だけ）、既存のイベント委譲
- **IMPORTS**: `popup-state` から `partitionViews, describeFold, foldNote, describeScores, describeBurstThreshold` / `storage` から `saveFoldTarget` / `domain` から `isFoldTarget` と型 `FoldTarget`
- **GOTCHA**:
  - `currentFoldTarget` は `renderCandidates` より**前**に代入する。`init` の順序を間違えると初回だけ折りたたまれない
  - `renderCandidates(state.views)` が `currentSettings` を読むので、`currentSettings = state.settings` を**その前**に置く（既存の順序で満たされているが、行を足すときに崩さない）
  - **同一ファイルへの Edit を並列に投げない。** ゲートが 1 本目を弾き、再実行で二重適用される事故を 2 回踏んでいる
- **VALIDATE**: `npx vitest run src/ui/popup/`

### Task 8: テストを書く

- **ACTION**: 5 つのテストファイルを更新
- **IMPLEMENT**: 下の「Testing Strategy」の表をそのまま実装する
- **MIRROR**: TEST_STRUCTURE の 2 つ（AAA / 実 HTML への固定）
- **GOTCHA**:
  - **`setupDom()` に新要素を足すのを忘れない。** 忘れると `find()` が null を返し、「要素が取れなければ何もしない」経路を通って**テストが通ってしまう**
  - `applyMock` は 5 項目の `Settings` を期待するようになる。`SETTINGS` 定数に 2 項目を足す
  - `loadMock.mockResolvedValue` に `foldTarget: 'none'` を足す
- **VALIDATE**: `npm run test` 全通過

### Task 9: 変異テスト（実装後に必ず実施）

- **ACTION**: 下の「変異テスト」表の 13 箇所を 1 つずつ壊し、狙ったテストが落ちることを確認して戻す
- **GOTCHA**: **落ちないものが 1 つでもあれば、そのテストは守っていない。** 消すか「守られていない」と JSDoc に書く。過去に 2 度、落ちようがないテストを書いている
- **VALIDATE**: 等価変異と明記した 2 件を除く 11 件が捕捉されること。**全件が同じ結論に揃ったらハーネスを疑う**（vitest の引数を確認する）

### Task 10: ドキュメントを更新する

- **ACTION**: PRD の Phase 表と CLAUDE.md の現在地を更新
- **IMPLEMENT**:
  - PRD: Phase 9 の行を `complete`（実機確認済み）に。PRP Plan 列にこの計画と report を張る
  - CLAUDE.md: 現在地の表を更新。**Phase 9 が終われば残るのは Phase 10（記事化）と完成前の掃除だけ**
  - 教訓が出たら CLAUDE.md の素材表に追記する
- **GOTCHA**: **長い文字列を `node -e` にシェル経由で渡さない。** バッククォートが解釈されて識別子が丸ごと消える事故を 2 回踏んでいる。置換文字列は必ずファイルに書いて経由させる
- **VALIDATE**: `git diff` を目で追い、表の行数が合っていることを確認する

---

## Testing Strategy

### Unit Tests

| # | ファイル | テスト | 何を守るか |
|---|---|---|---|
| 1 | `burst.test.ts` | 窓を 120 分にすると 90 分後のいいねが窓内になる | 引数が効いている |
| 2 | `burst.test.ts` | 窓を 30 分にすると 60 分後のいいねが窓外になる | 反対方向にも効く |
| 3 | `burst.test.ts` | 引数を省略すると `BURST_WINDOW_MINUTES` と同じ結果 | 既定引数（既存 9 ケースが無改変で通る根拠） |
| 4 | `burst.test.ts` | `BURST_WINDOW_MINUTES === DEFAULT_SETTINGS.burstWindowMinutes` | AD-4 の単一の出所 |
| 5 | `detector.test.ts` | **既定値（`DEFAULT_SETTINGS`）では候補が 1 件も減らない** | ★アップデートで見え方が変わらないこと |
| 6 | `detector.test.ts` | 下限 50% で burstScore 0.3 の候補が消える | フィルタが効く |
| 7 | `detector.test.ts` | **burstScore ちょうど 0.3・下限 30 は残る** | 浮動小数の境界（`0.3*100 = 30.000000000000004`） |
| 8 | `detector.test.ts` | 窓を広げると burstScore が上がり、同じ下限で候補が増える | 9a と 9b が連動する |
| 9 | `detector.test.ts` | **閾値で片方が落ちても、残った著者の `coAuthors` から消えない** | ★AD-3（作り直しの禁止） |
| 10 | `storage.test.ts` | 新項目を保存して読み戻せる | 往復 |
| 11 | `storage.test.ts` | **`minBurstScore: 0` が既定値に巻き戻らない** | ★AD-1（`asNonNegativeInt`） |
| 12 | `storage.test.ts` | `minBurstScore: -1` / `1.5` / `'30'` は既定値に倒す | 検証の下限 |
| 13 | `storage.test.ts` | `burstWindowMinutes: 0` は既定値に倒す | こちらは `asPositiveInt` のまま |
| 14 | `storage.test.ts` | 旧い 3 項目だけの保存値を読んでも、新項目が既定値で埋まる | マイグレーション不要の根拠 |
| 15 | `storage.test.ts` | `getFoldTarget` は未設定なら `'none'` / 知らない値も `'none'` | 既定と検証 |
| 16 | `storage.test.ts` | `saveFoldTarget` は `local` に書く（`sync` に書かない） | 判定の設定と混ぜない |
| 17 | `popup-state.test.ts` | `partitionViews('none')` は全部 open | 既定が素通し |
| 18 | `popup-state.test.ts` | `partitionViews('muted')` は `mutedAt` があるものだけ折りたたむ | AD-7 |
| 19 | `popup-state.test.ts` | **`outcome: 'not-on-page'` でも `mutedAt` があれば折りたたまれたまま** | ★AD-7（押し直しで飛び出さない） |
| 20 | `popup-state.test.ts` | `partitionViews('valid')` で「誤り」の著者は open に戻る | 回収経路 |
| 21 | `popup-state.test.ts` | `partitionViews('judged')` は valid も false_positive も折りたたむ | 4 択目 |
| 22 | `popup-state.test.ts` | `describeFold` は 0 件と `'none'` で空文字 | 器ごと出さない規約 |
| 23 | `popup-state.test.ts` | `foldNote` はミュート済みが 0 件なら空文字 | 関係ない注意書きを出さない |
| 24 | `popup-state.test.ts` | `foldNote` に `設定 > ミュート` が含まれる | OQ-16 の回収導線 |
| 25 | `popup-state.test.ts` | `describeScores` に幅が入る（60 と 180 で文言が違う） | 「数字の意味が読めない」の解消 |
| 26 | `popup-state.test.ts` | `describeBurstThreshold(0) === '無効'` / `(30) === '30%'` | 0 の意味 |
| 27 | `popup-state.test.ts` | `describeEmpty(true, 2)` が折りたたみを案内する | 「条件をゆるめて」と言わない |
| 28 | `popup-state.test.ts` | `loadPopupState` が `foldTarget` を返す | 配線 |
| 29 | `popup-page.test.ts` | 新スライダーの `change` で 5 項目が保存される | 配線 |
| 30 | `popup-page.test.ts` | 新スライダーの `input` では再検出も保存もしない | ★描画詰まりの再発防止 |
| 31 | `popup-page.test.ts` | `min-burst` を 0 にしたとき `0` が保存される（現在値に戻らない） | ★`readSettings` のガード |
| 32 | `popup-page.test.ts` | `burst-window-value` に「120 分」、`min-burst-value` に「無効」が出る | 表示 |
| 33 | `popup-page.test.ts` | 折りたたみを選ぶと該当の候補が `#folded-candidates` へ移る | 中核 |
| 34 | `popup-page.test.ts` | **折りたたみの変更で `applySettings` を呼ばない** | ★AD-8 |
| 35 | `popup-page.test.ts` | **折りたたみの中の「誤り」が効く** | ★OQ-16 の回収経路 |
| 36 | `popup-page.test.ts` | 折りたたみの中の根拠リンクが背景タブで開く | 委譲が届いている |
| 37 | `popup-page.test.ts` | 折りたたみの中の `設定 > ミュート` が背景タブで開く | 同上（`#fold-note`） |
| 38 | `popup-page.test.ts` | 全件折りたたまれても `#empty` が「条件をゆるめて」と言わない | 誤った案内 |
| 39 | `popup-page.test.ts` | **バッジは折りたたみで変わらない** | AD-6 |
| 40 | `popup-page.test.ts` | 保存済みの `foldTarget` が `<select>` に映る | init |
| 41 | `popup-page.test.ts` | `index.html`: `#fold-target` が `#candidates` より前、`#folded` が後ろ | レイアウト順序（実ファイル） |
| 42 | `popup-page.test.ts` | `index.html`: `<details id="folded"` に `open` が付いていない | 折りたたみの意味 |
| 43 | `popup-page.test.ts` | `index.html`: `#conditions` の中に `fold-target` が**無い** | 判定と表示を混ぜない |

### Edge Cases Checklist

- [x] 空入力 — 候補 0 件で折りたたみを切り替えても例外を投げない（#22）
- [x] 最大値 — `burstWindowMinutes: 360` / `minBurstScore: 100`（#12 の範囲テストで到達）
- [x] 不正な型 — `'30'` / `-1` / `1.5` / 知らない `foldTarget`（#12・#15）
- [x] 境界 — burstScore ちょうど閾値（#7）、0 という有効な設定値（#11・#31）
- [x] 同時実行 — 既存の `applyChain` と `busy` がそのまま効く（新しい非同期を足さない）
- [ ] ネットワーク障害 — **該当なし。このフェーズは API を 1 本も叩かない**
- [ ] 権限拒否 — **該当なし。権限は変更しない**（`storage` + `https://qiita.com/*` のまま）

---

## Validation Commands

### 静的解析

```bash
npx --no-install tsc --noEmit
```
EXPECT: 0 errors

### Lint と整形

```bash
npm run lint && npm run format
```
EXPECT: 0 problems ／ **`format` はどのゲートにも入っていないので必ず手で走らせる**（過去に 10 ファイルが静かにずれていた）

### ユニットテスト（影響範囲）

```bash
npx vitest run src/detect/ src/lib/storage.test.ts src/ui/popup/
```
EXPECT: 全通過

### 全体

```bash
npm run test -- --coverage
```
EXPECT: 全通過・Statements 96% 以上を維持

### ビルドと配線の検証

```bash
npm run build && cat dist/service-worker-loader.js && grep -o 'getURL("[^"]*")' dist/assets/*loader*.js
```
EXPECT: service worker と content script が**別々の正しいチャンク**を指すこと（ビルド成功は正しい配線を意味しない）

### JSDoc の孤立検査

```bash
node scratchpad/jsdoc-check.mjs
```
EXPECT: 新規の指摘ゼロ（`service-worker.ts:20` はモジュールヘッダーで既知の偽陽性）

### 権限が増えていないこと

```bash
node -e "const m=require('./dist/manifest.json');console.log(m.permissions,m.host_permissions)"
```
EXPECT: `[ 'storage' ] [ 'https://qiita.com/*' ]`

### Manual Validation（実機）

**Phase 8 で 3 周した教訓 — 手前の欠陥が奥の欠陥を隠す。1 つ直したら最初からやり直す。**

- [ ] `dist/` を未パック拡張として読み込み直す
- [ ] トレンドページを開く → **候補の件数がアップデート前と同じ**（既定値の維持）
- [ ] ポップアップ → 「判定の条件」を開く → **スライダーが 5 本ある**
- [ ] 「投稿直後とみなす幅」が **60 分**、「投稿直後の集中の下限」が **無効**
- [ ] 候補のスコア行が「**投稿から 60 分以内の集中 0.xx**」になっている
- [ ] 幅を 180 分に動かす → **つまみが指に追従する**（ドラッグが詰まらない）→ スコア行の文言が 180 に変わる
- [ ] 下限を 50% に動かす → **候補が減る**。見出しに「投稿 180 分以内の集中 50% 以上」が出る
- [ ] 下限を 0 に戻す → **「無効」に戻り、候補が元の件数に戻る**（★スライダーが左端に行かない不具合の検査）
- [ ] ポップアップを閉じて開き直す → **設定が残っている**
- [ ] 「評価が済んだものは」で「評価済みをすべて折りたたむ」を選ぶ → 評価済みが `<details>` に入る
- [ ] `<details>` を開く → **「誤り」が押せる** → **一覧に戻り、裏のトレンドページの記事も戻る**
- [ ] ミュート済みが居る状態で「ミュート済みだけ折りたたむ」→ **注意書きと `設定 > ミュート` のリンクが出る**
- [ ] そのリンクを押す → **背景タブで開き、ポップアップが閉じない**
- [ ] 「妥当」を押し直す → **折りたたみから飛び出さない**（★`mutedAt` で見ている検査）
- [ ] 「そのまま一覧に出す」に戻す → **全部戻る**
- [ ] 全件折りたたまれた状態 → **「条件をゆるめると増えます」と出ない**
- [ ] バッジの数字が折りたたみで変わらない
- [ ] **窓の幅がガタつかない**（候補の有無で左に 15px ずれない）
- [ ] `chrome://extensions` のエラー欄が**空のまま**

---

## 変異テスト（実装後に必ず実施）

**フィクスチャが実機と違えば網羅率は 1 ミリも保証しない**（Phase 8 で 17/17 捕捉して実機は 1 件も動かなかった）。ここは純粋関数と既存 DOM が中心なのでその危険は小さいが、**アサーションが真になる経路が 2 つ無いか**は毎回確認する。

| # | 壊す箇所 | 落ちるべきテスト |
|---|---|---|
| 1 | `burstScore` の `windowMinutes` を無視して `BURST_WINDOW_MINUTES` 固定に | 「窓を 120 分にすると窓内」 |
| 2 | `BURST_WINDOW_MINUTES` を `60` の直書きに戻す | 「`DEFAULT_SETTINGS` と一致する」（**直書きだと今は通るので、既定値を 90 に変えてから確認する**） |
| 3 | `detector` の `filter` を消す | 「下限 50% で候補が消える」 |
| 4 | `filter` を `>` に（`>=` ではなく） | 「ちょうど 0.3・下限 30 は残る」 |
| 5 | `filter` を `sort` の**後ろ**へ移す | **落ちない（等価変異）。** 落ちない理由を確かめること — フィルタと並べ替えは可換。**テストを足さず、順序を JSDoc で説明する** |
| 6 | `detector` で `settings.burstWindowMinutes` を渡さない | 「窓を広げると候補が増える」 |
| 7 | `coAuthors` を `filter` 後の候補から作り直す | 「閾値で落ちても coAuthors から消えない」 |
| 8 | `asNonNegativeInt` を `asPositiveInt` に差し替える | 「`minBurstScore: 0` が巻き戻らない」 |
| 9 | `getFoldTarget` の `isFoldTarget` を外す | 「知らない値も `'none'`」 |
| 10 | `partitionViews` の `mutedAt` を `outcome === 'muted'` に | 「`not-on-page` でも折りたたまれたまま」 |
| 11 | `readSettings` の `input.value === ''` ガードを外す | **要検討。** 落ちないなら「守られていない」と JSDoc に書く（range 入力は空にならない） |
| 12 | `#folded` にクリックリスナーを付けない | 「折りたたみの中の「誤り」が効く」 |
| 13 | `<select>` の change で `applySettings` を呼ぶ | 「折りたたみの変更で再検出しない」 |

---

## Acceptance Criteria

- [ ] スライダー 5 本が動き、値が `storage.sync` に保存され、開き直しても残る
- [ ] **既定値のままなら候補の件数・並び順・バッジがアップデート前と一致する**
- [ ] `minBurstScore` を 0 に戻せる（左端に行き、そこで止まる）
- [ ] 候補のスコア行に幅が入る
- [ ] 折りたたみ 4 択が動き、`storage.local` に保存される
- [ ] **折りたたみの中で「誤り」が押せ、押すとトレンドページの非表示も解ける**
- [ ] 空アカウント率・組織名の設定項目が**存在しない**
- [ ] 権限が増えていない
- [ ] `logger.error` / `logger.warn` が**想定内の失敗で**増えていない
- [ ] 変異テストのうち、等価変異と明記した 2 件を除く 11 件が捕捉される

## Completion Checklist

- [ ] 発見済みのパターンに従っている（`describeXxx` は空文字、storage は局所フォールバック、DOM は失敗しても投げない）
- [ ] ログの水準が規約どおり（想定内は `debug`）
- [ ] ハードコードした値が無い（可動域は `RANGES`、既定は `DEFAULT_SETTINGS`）
- [ ] **JSDoc が孤立していない**（`git diff` を目で追った）
- [ ] **同一ファイルへの Edit を並列に投げていない**（二重適用の検査として `git diff` で重複を見た）
- [ ] `npm run format` を実行した
- [ ] 実データ（実アカウント名・実 item_id）がテストに 1 件も入っていない
- [ ] ドキュメント（PRD / CLAUDE.md）を更新した
- [ ] 余計なスコープを足していない

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **既定値が現状維持になっておらず、アップデートで候補が変わる** | 低 | **高** | 「既定値では 1 件も減らない」テスト（#5）＋既存テストが無改変で通ることを合格条件にする |
| `minBurstScore: 0` が巻き戻る（`asPositiveInt` の流用） | 中 | 高 | AD-1。**既定を変えるまで露見しない**ので、テスト（#11）と変異 #8 で固定する |
| 折りたたみで誤検知を回収できなくなる（OQ-16 の再発） | 中 | 高 | 既定 `'none'`／中で「誤り」が押せる（#35）／`settings/mutes` への導線（#24）。**3 重にする** |
| 折りたたみ後にミュートの結果表示が見えなくなる | 中 | 低 | **受け入れる。**`<details>` の件数が増えることで移動は分かる。既定は `'none'` なので、選んだ人にだけ起きる。実機チェックリストに入れて目視する |
| `.slider` の桁幅変更で既存 3 本のレイアウトが崩れる | 低 | 低 | 3 列目を広げるだけ。既存の出力は右寄せなので位置が変わらない。実機で目視 |
| `setupDom()` に新要素を足し忘れ、テストが素通りする | **中** | 中 | Task 8 の GOTCHA に明記。加えて **実ファイル（`index.html?raw`）に対する順序テスト**（#41-43）が存在の側を押さえる |
| 浮動小数で境界がずれる | 低 | 中 | 境界テスト（#7）。`Math.round` を使わない |
| `popup-page.ts` が 800 行に近づく | 中 | 低 | 現状 571 行。判定と文言はすべて `popup-state.ts` に置き、`popup-page.ts` は配線に留める。**700 行を超えたら分割を検討する** |

## Notes

### このフェーズが小さい理由

**新しい判定軸を 1 つも作らないから。** `burstScore` は Phase 5 から存在し、`Candidate` に記録され、並び順のタイブレークに使われていた。**計算済みの値にフィルタを 1 行足し、定数を引数にするだけ。**

「開発者が閾値を追い込む」方針を撤回したことで、**データの蓄積を待つ工程が消えた**。Phase 9 が「待ちのフェーズ」でなくなり、Phase 10（記事化）を待たせる理由も消えている。

### `emptyAccountRatio` を開放しないことの意味

`burstScore` を開放して `emptyAccountRatio` を開放しないのは、**片方だけ実測で否定されているから**である。

- `burstScore`: 二極化を観測（`0.00 / 0.00 / 0.63 / 0.67 / 0.80`）。指標として機能している可能性が高い
- `emptyAccountRatio`: ユーザーが目視で見つけた 2 著者の共通 17 人で **6%**、インデックス全体は **38%**。**手口を素通りしただけでなく、より健全に見せた**

「両方スコアなのだから両方開放するのが一貫している」は**間違った一貫性**。測ってダメだと分かっているものを選択肢に出すと、善意で使った人が取りこぼす。

### 記事化（Phase 10）の素材になりうるもの

- **予測をやめると設計が減る、の 2 例目。**「開発者が正解を決める」をやめたら、蓄積を待つ工程・目標値・その達成判定の 3 つが消え、増えたのは設定項目 2 つと表示設定 1 つだった
- **`asPositiveInt(0)` が「今日は偶然動く」。**既定が 0 だから既定値へのフォールバックと結果が一致する。**既定を変えた瞬間に壊れる時限式の欠陥**で、テストも型も lint も通る
- **「1 つ開放しても件数は変わらない」。**幅（9a）だけでは `burstScore` がフィルタに使われていないので何も起きない。**開放という言葉が実際の効果を保証しない**
- **折りたたみは OQ-16 と同じ形をしている。**「視界から消す」機能は必ず「消したものを再評価できなくする」危険を持つ。既定オフ・中で操作可能・解除導線の 3 重で受ける
