# Plan: 検出の穴を塞ぐ（Phase 5b-1 — バグ 2 件）

## Summary

実在する相互いいねを 1 件も検出できなかった原因のうち、**バグ 2 件**を直す。著者巡回が起動しない問題と、フルモードで取った過去記事が判定に入らない問題。**著者間クラスタ（欠陥 3）は 5b-2 に分ける** — バグを直すとフルモードが初めて正常に動き、数日ぶんの実データが貯まる。閾値はその数値を見てから決める。

## User Story

As a トレンドを健全化したいユーザー,
I want トークンを設定したら著者の過去記事が実際に判定に使われること,
So that 記事が複数ある著者を取りこぼさずに検出できる.

## Problem → Solution

| | 現状 | 後 |
|---|---|---|
| 著者巡回 | `newItems` からしか著者を取らない。**トークンを後から設定すると永久に走らない** | 著者ごとの訪問記録で対象を決める |
| 判定の窓 | `itemPostedAt` から 3 日。**過去記事は取ったそばから捨てられる** | 既定 7 日（保持期間と同値）。フル前提の値にする |
| モード案内 | 枠の広さだけを説明 | **検出できる/できないの差**を説明する |

## Metadata

- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/qiita-trend-guard.prd.md`
- **PRD Phase**: Phase 5b（1/2）
- **調査**: [cross-author-collusion-investigation.md](../reports/cross-author-collusion-investigation.md)
- **Estimated Files**: 10（新規 2 / 更新 8）

---

## この計画の前提（ユーザーと合意済み）

1. **判定は 1 本のまま。** `detectCandidates` は `ScanMode` を引数に取らない（CLAUDE.md の約束 9 を守る）。「ライトのときだけ閾値を緩める」分岐を入れると、適合率 80% という単一指標に対して原因の切り分けができなくなる
2. **既定値をフルモード前提にする。** `lookbackDays` の既定を 3 → 7。ライトは「トークンなしでも一応動く縮退版」と位置づける
3. **著者間クラスタは 5b-2。** 母数が実測 1 スキャン（351 ペア中 1 組）しかない状態で判定を作ると、その 1 件に合わせた判定になる

---

## UX Design

### Before

```
┌──────────────────────────────────┐
│ ライトモードで動作中              │
│ いま画面に出ている記事だけを見ます。│
│ トークンを設定すると枠が 60 → 1000 │
│                    [トークンを設定]│
└──────────────────────────────────┘
   ↑ 枠の広さしか言わない。
     「検出できないものがある」とは書いていない
```

### After

```
┌──────────────────────────────────┐
│ ライトモードで動作中              │
│ いま画面に出ている記事だけを見ます。│
│ 同じ著者の記事が複数トレンドに出て │
│ いないと判定材料が揃いません。     │
│ トークンを設定すると過去記事まで辿り│
│ 枠も 60 → 1000 に広がります。      │
│                    [トークンを設定]│
└──────────────────────────────────┘
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| トークン未設定時の案内 | 枠の広さ | **判定材料が揃わないこと**を先に言う | 実測（27 記事で同一著者ペアの重なりが上位 10 に 1 つも無い）に基づく |
| 遡る日数の既定 | 3 | **7** | 既存ユーザーの `storage.sync` の値は変わらない（移行しない） |
| トークン設定後の初回スキャン | 何も起きない | **著者巡回が走る**（約 108 req） | 欠陥 1 の修正 |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| **P0** | `src/background/scanner.ts` | 387-430 | 著者巡回の起動条件。**ここが欠陥 1** |
| **P0** | `src/detect/like-index.ts` | 19-27, 95-134 | `RETENTION_DAYS` と `withinLookback`。**ここが欠陥 2** |
| **P0** | `src/lib/storage.ts` | 63-90 | storage アクセサのパターン。新しい器をここに足す |
| P1 | `src/types/domain.ts` | 86-135 | `Settings` / `DEFAULT_SETTINGS` / `LocalState` |
| P1 | `src/ui/popup/popup-state.ts` | 130-155 | `describeMode`。文言の組み立て方 |
| P2 | `src/background/scanner.test.ts` | 52-76, 176-189 | 時刻固定と「叩かない」ことの検査 |
| P2 | `src/api/rate-budget.ts` | 20-52 | `RATE_LIMIT_ANON` / `RATE_LIMIT_AUTH` / `decideMode` |

## External Documentation

外部調査は不要。**すべて内部パターンで完結する。**（`chrome.storage.local` の使い方は既存のアクセサと同型）

---

## Patterns to Mirror

### STORAGE_ACCESSOR
```ts
// SOURCE: src/lib/storage.ts:67-85
export async function getRateLimitedUntil(): Promise<number | null> {
  const raw = await readRaw();
  const value = raw.rateLimitedUntil;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function saveRateLimit(resetAt: number | null): Promise<void> {
  if (resetAt === null) {
    await chrome.storage.local.remove('rateLimitedUntil');
    return;
  }
  await chrome.storage.local.set({ rateLimitedUntil: resetAt });
}
```
**壊れた値は例外にせず既定へ倒す。** 自分で書いた値なので API レスポンスほど厳密には検証しない。

### PURE_LAYER（now を引数で受ける）
```ts
// SOURCE: src/detect/like-index.ts:13-15
 * 【now を引数で受け取る理由】
 * 関数内で new Date() を呼ぶとテストが実行時刻に依存して壊れる。
 * 呼び出し側が時刻を決め、この層は受け取った時刻だけを見る。
```
**これを破ったのが今日の 3 件のテスト落ちの原因。** 新しい純粋関数も必ず `now: Date` を受け取る。

### LOGGING（約束 4・11）
```ts
// SOURCE: src/background/scanner.ts:396
logger.info('trend items:', items.length, 'new:', newItems.length, 'mode=' + mode);
// SOURCE: src/background/scanner.ts:199
logger.debug('skip author:', handle, error);
```
`console` を直接呼ばない。**想定内の失敗は `logger.debug`。** warn / error は「拡張が壊れている」と読まれる。

### 判定に関わる定数の置き場
```ts
// SOURCE: src/detect/burst.ts:22-25
export const BURST_WINDOW_MINUTES = 60;
export const EMPTY_MAX_FOLLOWERS = 5;
```
マジックナンバーを埋め込まず、**根拠をコメントに書いて export する。**

### TEST_TIME（今日入れたばかり）
```ts
// SOURCE: src/background/scanner.test.ts:59-61
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2026-08-19T12:00:00+09:00'));
```
`Date` だけ偽装する。`setTimeout` まで止めると `runScan` の非同期が進まない。

### TEST_STRUCTURE
```ts
// SOURCE: src/background/scanner.test.ts:176-188
it('フルモードでも全件既知なら著者一覧を叩かない', async () => {
  // Arrange
  await saveToken('dummy-token-value');
  await runScan(TWO_ITEMS);
  vi.clearAllMocks();
  // Act
  await runScan(TWO_ITEMS);
  // Assert
  expect(likesMock).not.toHaveBeenCalled();
  expect(itemsMock).not.toHaveBeenCalled();
});
```
**このテストは書き換える。** 「全件既知なら叩かない」は**欠陥 1 そのもの**を守っていた。合成値は `example-author-N` 形式。**実アカウント名は使わない。**

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/background/author-visits.ts` | **CREATE** | 巡回対象を決める純粋関数。scanner から切り出してテスト可能にする |
| `src/background/author-visits.test.ts` | **CREATE** | |
| `src/types/domain.ts` | UPDATE | `AuthorVisits` 型、`LocalState.authorVisits`、`DEFAULT_SETTINGS.lookbackDays: 7` |
| `src/lib/storage.ts` | UPDATE | `getAuthorVisits` / `saveAuthorVisits` |
| `src/lib/storage.test.ts` | UPDATE | 壊れた値のフォールバック |
| `src/background/scanner.ts` | UPDATE | 巡回対象を訪問記録から決める。訪問時刻を記録する |
| `src/background/scanner.test.ts` | UPDATE | 「全件既知なら著者一覧を叩かない」を**再訪間隔ベースに書き換える** |
| `src/detect/like-index.ts` | UPDATE | コメントのみ（`RETENTION_DAYS` と `lookbackDays` の関係が同値を許す） |
| `src/ui/popup/popup-state.ts` | UPDATE | `describeMode` の文言 |
| `src/ui/popup/popup-state.test.ts` | UPDATE | |

## NOT Building

- **著者をまたぐ共起**（欠陥 3 / OQ-18）→ Phase 5b-2
- **likes の再取得間隔**（OQ-14 の本体）→ 訪問記録は器として使えるが、likes を取り直す判断は別
- **ライトモードの廃止** → PRD 改訂 4 を巻き戻さない
- **保持期間（`RETENTION_DAYS = 7`）の変更** → 法務判断に由来する値。触らない
- **`MAX_EXTRA_ITEMS_PER_AUTHOR` の増加** → 再訪のたびに 2 本ずつ遡れるようになるので、まず現状で測る
- **既存ユーザーの `lookbackDays` の移行** → 既定値だけ変える。保存済みの値は尊重する

---

## Step-by-Step Tasks

### Task 1: 訪問記録の型を足す

- **ACTION**: `src/types/domain.ts` に `AuthorVisits` を追加し、`LocalState` に載せる
- **IMPLEMENT**:
  ```ts
  /**
   * 著者ハンドル -> 最後に過去記事を辿った時刻。
   *
   * **「その著者を一度でも訪れたか」を記事 ID からは判定できない。**
   * 記事が 1 本しか無い著者と、まだ辿っていない著者が同じ見え方になるため。
   */
  export type AuthorVisits = Record<AccountHandle, IsoDateTime>;
  ```
  `LocalState` に `authorVisits?: AuthorVisits;`（保持期間 7 日でパージ対象）
- **MIRROR**: `FeedbackLog = Record<AccountHandle, Verdict>`（同じ形）
- **GOTCHA**: `LocalState` はドキュメント用の型で、`storage.ts` は個別に読む。**両方直さないと型が嘘になる**
- **VALIDATE**: `npx tsc --noEmit`

### Task 2: 既定の窓を 7 日にする

- **ACTION**: `DEFAULT_SETTINGS.lookbackDays` を 3 → 7。`like-index.ts` のコメントを直す
- **IMPLEMENT**: `like-index.ts:24` の「判定に使う遡及窓（`Settings.lookbackDays`）より必ず長くすること」を、
  ```
   * 判定に使う遡及窓（Settings.lookbackDays）と**同値でよい**。
   * 逆転（lookback > RETENTION）だけを避ける — 判定に入らないレコードを
   * 保存し続けることになるため。改訂 6 以降はフルモードを主軸にするので、
   * 既定は同値（7 日）に置く。
  ```
  `like-index.ts:129` の「purgeLikeIndex より短い窓（既定 3 日 = トレンドセット 6 回分）」も更新
- **MIRROR**: 定数のコメントに根拠を書く（`BURST_WINDOW_MINUTES` と同型）
- **GOTCHA**: **既存ユーザーの `storage.sync` に保存済みの値は変わらない。** `getSettings` は保存値を優先する。移行処理は書かない（ユーザーがスライダーで変えられる）
- **VALIDATE**: `detector.test.ts` / `like-index.test.ts` が通ること。既定値を参照しているテストがあれば期待値を直す

### Task 3: 巡回対象を決める純粋関数

- **ACTION**: `src/background/author-visits.ts` を新規作成
- **IMPLEMENT**:
  ```ts
  /**
   * 著者を再訪する間隔。
   *
   * 過去記事は 1 回の訪問で MAX_EXTRA_ITEMS_PER_AUTHOR 本ずつ遡る。
   * 再訪すると次の 2 本に進むので、間隔は「どれだけ速く遡るか」を決める。
   * フルモードは 1 スキャン約 108 req で枠は 1000 req/h。24 時間なら余裕がある。
   */
  export const AUTHOR_REVISIT_HOURS = 24;

  /** まだ訪れていない、または前回から AUTHOR_REVISIT_HOURS 経った著者を返す */
  export function authorsToVisit(
    handles: AccountHandle[],
    visits: AuthorVisits,
    now: Date,
  ): AccountHandle[];

  /** 訪問した著者の時刻を今にする（新しいオブジェクトを返す） */
  export function recordVisits(
    visits: AuthorVisits,
    handles: AccountHandle[],
    now: Date,
  ): AuthorVisits;

  /** index に居ない著者の記録を落とす。purge と同じタイミングで呼ぶ */
  export function pruneVisits(visits: AuthorVisits, index: LikeIndex): AuthorVisits;
  ```
- **MIRROR**: `like-index.ts` の純粋関数（`now` を引数で受ける・新しいオブジェクトを返す）
- **IMPORTS**: `import type { AccountHandle, AuthorVisits, LikeIndex } from '../types/domain';`
- **GOTCHA**:
  - **重複を畳んでから返す。** トレンドに同じ著者の記事が 2 本あると `handles` に 2 回出る
  - `toEpochMs` は `like-index.ts` から import する（**パースできない値は `null`** で、`NaN` 比較が全部 false になる罠を避けるため）。パース不能な記録は「未訪問」として扱う
  - **immutable**（CLAUDE.md の coding-style）。`visits` を破壊的に書き換えない
- **VALIDATE**: 新規テストで、未訪問 / 23 時間前 / 25 時間前 / 壊れた値 / 重複ハンドル を固定

### Task 4: scanner の配線を直す

- **ACTION**: `scanTrend` の著者巡回を訪問記録ベースにする
- **IMPLEMENT**: `scanner.ts:419-428` を置き換える
  ```ts
  // 著者は items（トレンド全件）から取る。newItems から取ると、
  // ライトで蓄積したあとにトークンを設定した人は **永久に** 過去記事を
  // 取りに行かない（2026-08-23 の実機で判明）。無駄打ちは訪問記録で防ぐ
  if (mode === 'full' && !progress.rateLimited) {
    const visits = await storage.getAuthorVisits();
    const handles = authorsToVisit(items.map((item) => item.authorHandle), visits, now);
    if (handles.length > 0) {
      progress = await scanAuthorHistory(handles, token, fresh, seen, progress);
      await storage.saveAuthorVisits(recordVisits(visits, handles, now));
    }
  }
  ```
- **MIRROR**: `persistIndexAndDetect` と同じく、storage への書き込みは scanner に閉じる（純粋層は触らない）
- **GOTCHA**:
  - **429 で止まった著者も「訪問済み」にしてよいか。** → してはいけない。`scanAuthorHistory` は `progress.rateLimited` で中断するため、**辿れなかった著者まで記録すると次回に飛ばされる**。`scanAuthorHistory` が実際に処理した著者だけを記録する（戻り値に含めるか、中断位置を返す）
  - `now` は `scanTrend` の中で 1 度だけ作り、使い回す（`startedAt` と揃える）
  - **同時実行ガード（`scanning`）は既にある。** 訪問記録の lost update は起きない
- **VALIDATE**:
  - 「トークン設定後の初回スキャンで、全件既知でも著者巡回が走る」（**欠陥 1 の番人**）
  - 「24 時間以内に再訪しない」
  - 「429 で止まったら、辿れなかった著者は訪問済みにしない」

### Task 5: モード案内の文言

- **ACTION**: `describeMode` のライトモード側を実測に合わせる
- **IMPLEMENT**:
  ```ts
  detail: `いま画面に出ている記事だけを見ます。同じ著者の記事が複数トレンドに出ていないと判定材料が揃いません。トークンを設定すると著者の過去記事まで辿れ、1 時間あたりの枠も ${String(RATE_LIMIT_ANON)} → ${String(RATE_LIMIT_AUTH)} リクエストに広がります。`,
  ```
- **MIRROR**: 既存の `describeMode`（テンプレートリテラルで定数を埋める）
- **GOTCHA**: **断定しない**（約束 6）。「検出できません」と書かず「判定材料が揃いません」に留める。ライトでも検出できる場合はある
- **VALIDATE**: `popup-state.test.ts` の既存テストが文言を substring で見ているか確認し、必要なら期待値を更新

### Task 6: 実機確認

- **ACTION**: `npm run build` → 未パック拡張を読み込み直す
- **VALIDATE**: 下の「Manual Validation」を全部通す

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected | Edge? |
|---|---|---|---|
| 未訪問の著者を返す | `visits: {}` | 全員 | |
| 23 時間前に訪問した著者は返さない | `now - 23h` | `[]` | 境界 |
| 25 時間前なら返す | `now - 25h` | 全員 | 境界 |
| 重複ハンドルを畳む | 同じ著者 2 本 | 1 件 | ✓ |
| パースできない記録は未訪問扱い | `'not-a-date'` | 返す | ✓ |
| `recordVisits` は元を壊さない | 既存 visits | 別オブジェクト | ✓ |
| `pruneVisits` は index に無い著者を落とす | 空 index | `{}` | ✓ |
| **全件既知でもトークン設定後は著者巡回が走る** | 2 回目のスキャン | `itemsMock` が呼ばれる | **欠陥 1 の番人** |
| 24 時間以内の再スキャンでは巡回しない | 直後の 2 回目 | `itemsMock` 未呼び出し | |
| **429 で止まった著者は訪問済みにしない** | 1 人目で 429 | 2 人目は記録されない | ✓ |
| 壊れた `authorVisits` は `{}` に倒す | `authorVisits: 'x'` | `{}` | ✓ |
| **既定の窓が 7 日** | `DEFAULT_SETTINGS` | `lookbackDays === 7` | |
| 7 日前の記事は判定に入る | `itemPostedAt: now-6d` | 候補になる | **欠陥 2 の番人** |
| 8 日前の記事は入らない | `itemPostedAt: now-8d` | 候補にならない | 境界 |

### Edge Cases Checklist

- [x] 空入力（`handles: []` → 巡回しない・storage に書かない）
- [x] 壊れた保存値（`authorVisits` が配列 / 文字列 / null）
- [x] 境界（23h / 24h / 25h、6d / 7d / 8d）
- [x] 重複（同じ著者の記事が 2 本）
- [x] 中断（429 で途中まで）
- [x] 同時実行（既存の `scanning` ガードで担保。**新規テストは書かない**）
- [ ] 権限拒否 → 該当なし（`storage.local` のみ）

### 変異テスト（実装後に必ず実施）

CLAUDE.md の教訓「**テストを書いたら、直した箇所を戻して落ちることを必ず確認する**」。最低これだけは壊して確認する:

| 壊す箇所 | 落ちるべきテスト |
|---|---|
| 著者を `items` → `newItems` に戻す | 「トークン設定後は著者巡回が走る」 |
| `AUTHOR_REVISIT_HOURS` の比較を `>=` → `>` | 境界（24h ちょうど） |
| `recordVisits` を破壊的更新にする | 「元を壊さない」 |
| `DEFAULT_SETTINGS.lookbackDays` を 7 → 3 | 「7 日前の記事は判定に入る」 |
| 429 中でも訪問記録を書く | 「429 で止まった著者は訪問済みにしない」 |

**落ちなかったものは、テストが守っていないか、コメントが間違っている。** どちらかを確定させるまで進めない。

---

## Validation Commands

### Static Analysis
```bash
npx --no-install tsc --noEmit
```
EXPECT: 0 errors

### Lint & Format
```bash
npm run lint && npm run format
```
EXPECT: 0 problems ／ **`format` はどのゲートにも入っていないので手で走らせる**

### Unit Tests
```bash
npm run test -- --run --coverage
```
EXPECT: 全通過・Statements 96% 以上を維持

### Build & 配線確認
```bash
npm run build && cat dist/service-worker-loader.js
```
EXPECT: `service-worker.ts-*.js` を指していること（**ビルド成功は正しい配線を意味しない**）

### Manual Validation（実機）

- [ ] `dist/` を未パック拡張として読み込み直す
- [ ] **トークンを設定した状態でトレンドを開く** → ログに `fetched:` が 0 でない数字
- [ ] **同じページをすぐリロード** → `fetched: 0`（24 時間以内なので巡回しない）
- [ ] ポップアップの「遡る日数」が **7** になっている（新規インストール時）
- [ ] ライトモード（トークンを消す）の案内に「判定材料が揃いません」が出る
- [ ] **`chrome://extensions` のエラー欄が空のまま**（約束 11 の番人）
- [ ] 調査で使った 2 著者のうち、**記事が複数ある方が候補に出る**
- [ ] 記事 1 本の方は**出ない**（これは 5b-2 の担当。ここで出たら想定と違うので調べ直す）

---

## Acceptance Criteria

- [ ] Task 1〜6 完了
- [ ] Validation Commands すべて通過
- [ ] 変異テストの 5 項目すべてで、狙ったテストが落ちる
- [ ] 型エラー 0 / lint 0 / 整形済み
- [ ] **実アカウント名・記事 URL がコード・テスト・ドキュメントに 1 つも無い**

## Completion Checklist

- [ ] `now` を引数で受け取る純粋層の規約を守っている
- [ ] `logger.debug` / `logger.info` の使い分けが約束 11 に沿っている
- [ ] 定数に根拠のコメントがある
- [ ] `storage.ts` 以外でキー名の文字列を書いていない
- [ ] 落ちようがないテストを残していない
- [ ] レポートを `.claude/PRPs/reports/` に書いた

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **既定を 7 日にすると誤検知が増える** | **M** | **M** | 適合率フィードバック（Phase 6）で測る。**測る手段は既にある。**増えたらスライダーで下げられる |
| 訪問記録が増え続ける | M | L | `pruneVisits` を purge と同じタイミングで呼ぶ |
| 429 の中断位置と訪問記録がずれる | M | M | 「辿れた著者だけ記録」をテストで固定。**ずれると次回に飛ばされて永久に取りこぼす** |
| 24 時間ごとに 108 req 使う | L | L | 認証枠 1000 req/h。1 日 1 回なら 11% |
| **修正がまた反対側の端に振り切れる** | **M** | **M** | 今回の欠陥 1 がまさにそれ（叩きすぎ → 叩かなすぎ）。**「叩く」「叩かない」の両方をテストで固定する** |
| 5b-2 の設計が変わって型が二度手間になる | L | M | `Candidate` を触らない範囲に留める。著者間クラスタは 5b-2 で `coAuthors?` を optional 追加する想定 |

## Notes

- **`lookbackDays` の既定を変えても既存ユーザーの設定は変わらない。** これは意図的。`getSettings` は保存値を優先し、移行処理は書かない
- **`AUTHOR_REVISIT_HOURS = 24` は初期値。** 実データを見て 5b-2 か Phase 9 で調整する。OQ-14（likes の再取得間隔）とは**別の値**で、混ぜない
- 今日の調査で `scanner.test.ts` の 3 件が**日付が変わっただけで落ちた**。新しいテストも必ず `vi.setSystemTime` で時刻を固定する
- **この計画は欠陥 3 を含まない。** 記事 1 本の著者は依然として検出できない。5b-2 の入力にするため、5b-1 のリリース後に数日ぶんのデータを貯める
