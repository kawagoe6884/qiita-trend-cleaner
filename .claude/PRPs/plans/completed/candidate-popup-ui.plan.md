# Plan: 候補 UI・設定 UI（Phase 6）

## Summary

ポップアップに **候補一覧・N/M/日数スライダー・適合率・429 案内** を置く。判定エンジン（`src/detect/`）のロジックは変えず、蓄積済みインデックスに対して `detectCandidates` を呼び直すだけ。API は 1 本も叩かない。

これは **唯一の成功指標（適合率 80%）を測る手段** である。PRD が「計測手段のない指標は成立しない」と書いたとおり、この UI が無い限り Phase 9 は始められない。

## User Story

As a Qiita のトレンド面を日常的に開く読者,
I want 検出された候補を根拠つきで確認し、妥当かどうかを記録したい,
So that 閾値を勘ではなく実測した適合率で調整できる。

## Problem → Solution

**現在**: 候補は `logger.info` にしか出ない。`chrome://extensions` の service worker コンソールを開かないと存在すら分からず、妥当性を記録する場所も無い。閾値は `DEFAULT_SETTINGS` 固定。

**目標**: ツールバーのアイコン 1 クリックで、候補・根拠・適合率が見え、その場で「妥当 / 誤り」を記録でき、閾値を動かすと結果が即座に変わる。

## Metadata

- **Complexity**: Large
- **Source PRD**: `.claude/PRPs/prds/qiita-trend-cleaner.prd.md`（改訂 6）
- **PRD Phase**: Phase 6（候補 UI・設定 UI）— depends on 5
- **Estimated Files**: 新規 4 / 変更 10

---

## UX Design

### Before

```
┌────────────────────────────────────────────┐
│ ツールバーのアイコンを押す                 │
│   ↓                                        │
│ 「Qiita Trend Guard — 未設定」             │
│                                            │
│ 候補は service worker の console にしか     │
│ 出ない。妥当性を記録する場所が無い         │
└────────────────────────────────────────────┘
```

### After

```
┌─ ポップアップ（幅 520px）───────────────┐
│ 候補 2 件 / 適合率 —（未評価）          │
│ 最終スキャン 2026-08-20 12:34            │
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │ example-author-f                     │ │
│ │ 9 アカウントが 2 記事に共通          │ │
│ │ 投稿直後の集中 0.00 / 空アカ 0.56    │ │
│ │ 根拠: 記事A ↗  記事B ↗               │ │
│ │ [ 妥当 ] [ 誤り ]                    │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ ─ 判定の条件 ─────────────────────────── │
│ 何人そろったら  N ▬▬●──── 5             │
│ 何記事に共通    M ▬●───── 2             │
│ さかのぼる日数    ▬▬●──── 3日           │
│                                          │
│ [トークンを設定する]                     │
└──────────────────────────────────────────┘
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| 候補の確認 | service worker の console | **ポップアップ** | |
| 妥当性の記録 | 不可能 | **候補ごとに 2 ボタン** | 適合率の唯一の入力 |
| 閾値 | `DEFAULT_SETTINGS` 固定 | **スライダー**（`storage.sync`） | 動かすと即座に再検出 |
| 429 | ログのみ | **「あと N 分」＋フルモード案内** | 4b から持ち越し |
| バッジ | 無し | **候補件数**（429 中は `!`） | |
| options ページ | トークン設定 | **変更なし** | 責務を増やさない |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/ui/options/token-form.ts` | 1-40, 60-130 | **純粋ロジック層の書き方。** DOM を触らない理由がファイル冒頭に書いてある |
| P0 | `src/ui/options/options-page.ts` | all | **DOM 配線層。** SELECTORS 定数・`find()` フェイルセーフ・`busy` フラグ・`init()` を export する理由 |
| P0 | `src/ui/options/options-page.test.ts` | 1-45 | jsdom で `init()` を叩くテストの形 |
| P0 | `src/types/domain.ts` | 45-110 | `Candidate` / `Settings` / `Verdict` / `LocalState` |
| P1 | `src/lib/storage.ts` | all | アクセサの追加場所とフェイルセーフの程度 |
| P1 | `src/detect/detector.ts` | all | `detectCandidates(index, settings, now)` の契約 |
| P1 | `src/background/scanner.ts` | 220-300 | `DEFAULT_SETTINGS` 直参照を storage 経由に変える箇所 |
| P2 | `src/ui/options/index.html` | 1-95 | CSS の書き方と **`[hidden]` を殺さない書き方** |

## External Documentation

外部研究は不要。**DOM API・chrome.action・既存の内部パターンだけで完結する。**

```
KEY_INSIGHT: chrome.action.setBadgeText は manifest に action があれば権限不要
APPLIES_TO: service-worker.ts のバッジ更新
GOTCHA: バッジは実質 4 文字。「あと 42 分」は入らない。件数か記号だけ
```

```
KEY_INSIGHT: storage.sync は 1800 writes/hour（PRD 実測表）
APPLIES_TO: スライダーの永続化
GOTCHA: input イベントはドラッグ中に連続発火する。保存は change、再計算は input
```

---

## Patterns to Mirror

### 純粋ロジックと DOM 配線の分離（LAYER_SPLIT）

```ts
// SOURCE: src/ui/options/token-form.ts:1-10
/**
 * トークン設定 UI の状態遷移とメッセージ決定。
 *
 * 【DOM を参照しない理由】
 * document を触るのは main.ts の責務にする。selectors.ts で DOM の知識を
 * 1 ファイルに隔離したのと同じ思想で、「401 では保存しない」のような
 * 重要な性質をユニットテストで固定できるようにする。
 */
```

**要点**: `popup-state.ts` が状態と文言を作り、`popup-page.ts` がそれを DOM に映すだけにする。

### DOM 配線のフェイルセーフ（DOM_WIRING）

```ts
// SOURCE: src/ui/options/options-page.ts:22-40
const SELECTORS = {
  form: '#token-form',
  token: '#token',
  ...
} as const;

function find<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}
```

**要点**: セレクタは 1 箇所に集約し、取れなければ黙って何もしない。

### 実行中フラグ（BUSY_FLAG）

```ts
// SOURCE: src/ui/options/options-page.ts:42-50
/**
 * 送信・削除の実行中フラグ。
 * 送信と削除が同時に走って互いの描画を上書きする問題も同じ根による。
 */
let busy = false;
```

**要点**: 非同期の往復中に来た操作は無視する。`scanner.ts` の `scanning` も同じ形。

### リスナーは storage より先に付ける（LISTENER_FIRST）

```ts
// SOURCE: src/ui/options/options-page.ts:210-223
export async function init(): Promise<void> {
  setBusy(false);
  attachListeners();
  try {
    render(await loadState());
  } catch (error) {
    logger.error('failed to load token state:', error);
    clearMode();
    showMessage('設定の読み込みに失敗しました。ページを再読み込みしてください。');
  }
}
```

**要点**: storage が読めなくてもリスナーだけは必ず付いた状態にする。

### storage アクセサ（STORAGE_ACCESSOR）

```ts
// SOURCE: src/lib/storage.ts:87-96
/**
 * 検出された候補。Phase 6 の一覧 UI の入力になる。
 * getLikeIndex は「配列なら壊れている」と判定するが、こちらは配列が正しい形。
 */
export async function getCandidates(): Promise<Candidate[]> {
  const raw = await readRaw();
  const list = raw.candidates;
  if (!Array.isArray(list)) return [];
  return list as Candidate[];
}
```

**要点**: 壊れた値でも例外を投げず既定値へ倒す。

### ログ（LOGGING_PATTERN）

想定内の失敗は `logger.debug`。**Chrome は `console.warn` もエラー欄に集める**（設計上の約束 4・11）。ポップアップで新たに `warn` / `error` を増やさないこと。想定外の例外だけ `logger.error`。

### テスト（TEST_STRUCTURE）

```ts
// SOURCE: src/ui/options/options-page.test.ts:22-45
/** index.html と同じ骨格。id と hidden の扱いを実物に合わせる */
function setupDom(): void {
  document.body.innerHTML = `...`;
}

function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}
```

**要点**: `index.html` と同じ id 構成を再現する。フィクスチャは合成値のみ（`example-author-N`）。

---

## 中核の設計

### 1. 評価は `Candidate` に持たせない

閾値を動かすと `detectCandidates` が候補を作り直す。`verdict` を `Candidate` の中に置いたままだと、**スライダーを 1 つ動かした瞬間にそれまでの評価が全部消える**。適合率は評価の蓄積そのものなので、これは指標の破壊にあたる。

```
storage.local.feedback: { "<authorHandle>": "valid" | "false_positive" }
```

**キーは著者ハンドルだけにする。** 根拠記事を含めない理由は、閾値を変えると根拠記事の集合が変わるが、「この著者は妥当か」というユーザーの判断は変わらないため。1 著者 1 評価、上書き可能。

適合率 = `valid の数 / (valid + false_positive の数)`。PRD の式そのまま。

**`Candidate.verdict` は型ごと削除する。** 真実の置き場を 2 つ持つと必ずずれる。

### 2. スライダーは `input` で再計算し、`change` で保存する

`storage.sync` は **1800 writes/hour**（PRD 実測表）。`input` イベントはドラッグ中に連続発火するため、そのまま保存すると数秒で上限に届く。

| イベント | すること |
|---|---|
| `input` | 再検出してプレビュー（storage への書き込み無し） |
| `change` | `storage.sync` へ保存 ＋ `candidates` を保存 |

### 3. 再検出はポップアップが直接行う

`detectCandidates` は純粋関数で、入力は `storage.local.likeIndex` にある。ポップアップも拡張のコンテキストなので storage を直接読める。**service worker を経由すると、寝ている worker を起こす往復が増えるだけで得るものが無い。**

**API は 1 本も叩かない。** スライダーを動かしてもレート枠は減らない。

### 4. `scanner.ts` も storage の設定を読む

現在は `DEFAULT_SETTINGS` を直接参照している（`scanner.ts:231-233, 281`）。このままだとスライダーを動かしても、**次のスキャンが既定値で `candidates` を上書きする**。

### 5. バッジの優先順位

```
429 中          → "!"      （残り時間はバッジに入らない。ポップアップで伝える）
候補 1 件以上   → 件数
それ以外        → 空文字
```

`chrome.action.setBadgeText` は manifest に `action` があれば権限不要。Phase 7 の除外件数バッジはこの規則の上に載せる。

### 6. 根拠記事へのリンクは必須

`sharedItemIds` から `https://qiita.com/{authorHandle}/items/{itemId}` を組み立て、`target="_blank" rel="noreferrer"` で開く。**リンクが無いとユーザーは記事を読めず、「妥当 / 誤り」が当てずっぽうになる。**当てずっぽうの入力から出る適合率は、指標として無価値になる。

### 7. 断定しない文言（設計上の約束 6）

「不正アカウント」「スパム」と書かない。表示は事実だけに留める。

| 出す | 出さない |
|---|---|
| 「9 アカウントが 2 記事に共通」 | 「組織票」 |
| 「投稿直後の集中 0.92」 | 「不正」 |
| 「妥当 / 誤り」 | 「シロ / クロ」 |

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/ui/popup/popup-state.ts` | CREATE | 状態・適合率・文言の純粋ロジック |
| `src/ui/popup/popup-state.test.ts` | CREATE | 同上のテスト |
| `src/ui/popup/popup-page.ts` | CREATE | DOM 配線（`init()` を export） |
| `src/ui/popup/popup-page.test.ts` | CREATE | jsdom で `init()` を叩く |
| `src/ui/popup/index.html` | UPDATE | 一覧・スライダー・適合率のマークアップ |
| `src/ui/popup/main.ts` | UPDATE | エントリ。`init()` を呼ぶだけ |
| `src/lib/storage.ts` | UPDATE | `getSettings` / `saveSettings` / `getFeedback` / `saveVerdict` |
| `src/lib/storage.test.ts` | UPDATE | 同上 |
| `src/types/domain.ts` | UPDATE | `Candidate.verdict` 削除、`LocalState.feedback` 追加、`FeedbackLog` 新設 |
| `src/detect/detector.ts` | UPDATE | `verdict: null` を落とす |
| `src/detect/detector.test.ts` | UPDATE | 期待値から `verdict` を外す |
| `src/background/scanner.ts` | UPDATE | 設定を storage から読む ＋ バッジ更新 |
| `src/background/scanner.test.ts` | UPDATE | 設定とバッジのテスト |
| `src/test/setup.ts` | UPDATE | `chrome.action` のモックを追加 |

## NOT Building

- **一括ミュート実行** — Phase 8。ボタンも置かない
- **DOM 即時非表示・除外件数バッジ** — Phase 7
- **options ページの変更** — トークン設定はそのまま。責務を増やさない
- **候補の履歴・時系列** — 現在の候補だけを出す
- **フルモードでの likes 再取得**（OQ-14）— 取得間隔が未定
- **`emptyAccountRatio` の判定条件への昇格**（OQ-15）— 表示するだけ。Phase 9 で測ってから

---

## Step-by-Step Tasks

推奨順序: `domain` → `storage` → `detector` → `scanner` → `popup-state` → `popup-page` → `html` → `main` → 検証。**型を先に動かすと、後続の変更箇所が型エラーとして機械的に出る。**

### Task 1: `src/types/domain.ts`

- **ACTION**: 評価の置き場を `Candidate` から外す
- **IMPLEMENT**:
  ```ts
  /** 候補に対するユーザーの判定。適合率の計算に使う */
  export type Verdict = 'valid' | 'false_positive';

  /**
   * 著者ハンドル -> 判定。
   *
   * **Candidate の中に持たない。** 閾値を動かすと detectCandidates が候補を
   * 作り直すため、そこに置くと評価が毎回消える。キーを著者だけにするのは、
   * 根拠記事の集合は閾値で変わるが「この著者は妥当か」の判断は変わらないため。
   */
  export type FeedbackLog = Record<AccountHandle, Verdict>;
  ```
  `Candidate` から `verdict: Verdict | null;` を削除。`LocalState` に `feedback?: FeedbackLog;` を追加
- **GOTCHA**: `Candidate.verdict` を消すと `detector.ts` と `storage.test.ts` のフィクスチャが型エラーになる。**それが正しい**（Task 3・7 で直す）
- **VALIDATE**: `npm run typecheck` — 落ちる箇所が変更対象の一覧になる

### Task 2: `src/lib/storage.ts`

- **ACTION**: 設定と評価のアクセサを足す
- **IMPLEMENT**:
  ```ts
  /**
   * 判定の閾値。**sync に置く唯一のデータ**（PRD のストレージ設計）。
   * 共起インデックスは 10 MB 級になるので local 固定、これだけが sync。
   */
  export async function getSettings(): Promise<Settings> {
    const raw: unknown = await chrome.storage.sync.get('settings');
    // ... 3 つの数値が揃っていなければ DEFAULT_SETTINGS
  }

  export async function saveSettings(settings: Settings): Promise<void>

  export async function getFeedback(): Promise<FeedbackLog>
  export async function saveVerdict(handle: AccountHandle, verdict: Verdict): Promise<void>
  ```
- **MIRROR**: `STORAGE_ACCESSOR`
- **GOTCHA**:
  - `getSettings` は **フィールド単位で検証する**。`{minClusterSize: "5"}` のような壊れ方を通すと `findClusters` の比較が全部 false になり、候補が黙ってゼロになる
  - `readRaw()` は `chrome.storage.local` を読む。設定は **sync** なので使い回さない
  - `saveVerdict` は読んで足して書く。全件上書きにするとポップアップを 2 枚開いたときに消し合う
- **VALIDATE**: `npx vitest run src/lib`

### Task 3: `src/detect/detector.ts`

- **ACTION**: `verdict: null` を落とす
- **GOTCHA**: **`src/detect/` のロジックはこれ以外触らない。** 判定は 1 本のまま
- **VALIDATE**: `npx vitest run src/detect`

### Task 4: `src/background/scanner.ts`

- **ACTION**: 設定を storage から読み、スキャン後にバッジを更新する
- **IMPLEMENT**:
  - `persistIndexAndDetect` の中で `const settings = await storage.getSettings();`
  - `detectCandidates(kept, settings, now)` と `logCandidates(candidates, settings)`
  - バッジ更新を関数に切る:
    ```ts
    /**
     * バッジは 4 文字程度しか入らない。429 の残り時間は入らないので記号にし、
     * 「あと N 分」はポップアップで伝える。
     */
    async function updateBadge(count: number, rateLimited: boolean): Promise<void> {
      const text = rateLimited ? '!' : count > 0 ? String(count) : '';
      await chrome.action.setBadgeText({ text });
    }
    ```
- **GOTCHA**:
  - `DEFAULT_SETTINGS` の import は `logCandidates` からも消える。**引数で受け取る形に変える**
  - `chrome.action` はテストのモックに無い。Task 11 で足すまでテストが落ちる
  - バッジ更新の失敗でスキャンを落とさない（`catch` して `logger.debug`）
- **VALIDATE**: `npx vitest run src/background`

### Task 5: `src/ui/popup/popup-state.ts`

- **ACTION**: 新規。純粋ロジックだけを置く
- **IMPLEMENT**:
  ```ts
  /** 適合率。分母が 0 のときは null（「—」と表示する。0% ではない） */
  export interface Precision {
    valid: number;
    falsePositive: number;
    ratio: number | null;
  }
  export function precisionOf(feedback: FeedbackLog): Precision

  /** 表示 1 件分。Candidate に verdict と根拠 URL を重ねたもの */
  export interface CandidateView {
    candidate: Candidate;
    verdict: Verdict | null;
    evidence: { itemId: ItemId; url: string }[];
  }
  export function toViews(candidates: Candidate[], feedback: FeedbackLog): CandidateView[]

  /** 429 の残り時間。過ぎていれば null */
  export function rateLimitNotice(until: number | null, now: Date): string | null

  /** ポップアップが描くもの全部 */
  export interface PopupState {
    views: CandidateView[];
    precision: Precision;
    settings: Settings;
    rateLimitNotice: string | null;
    lastScanAt: IsoDateTime | null;
  }
  export async function loadPopupState(now: Date): Promise<PopupState>
  export async function recompute(settings: Settings, now: Date): Promise<CandidateView[]>
  ```
- **MIRROR**: `LAYER_SPLIT`。`document` を 1 度も参照しないこと
- **IMPORTS**:
  ```ts
  import * as storage from '../../lib/storage';
  import { detectCandidates } from '../../detect/detector';
  import type { Candidate, FeedbackLog, ItemId, IsoDateTime, Settings, Verdict } from '../../types/domain';
  ```
- **GOTCHA**:
  - **`ratio` は分母 0 で `null`。`0` にしない。** 「まだ測っていない」と「0% だった」は別物で、Phase 9 の判断が変わる
  - `rateLimitNotice` の単位は **Unix 秒**。`Date.now()` はミリ秒
  - 根拠 URL は `authorHandle` と `itemId` から組み立てる。`Candidate` に URL は無い
- **VALIDATE**: `npx vitest run src/ui/popup/popup-state.test.ts`

### Task 6: `src/ui/popup/popup-state.test.ts`

- **ACTION**: Task 5 のテスト
- **IMPLEMENT**: 下の Testing Strategy の「popup-state」節をすべて
- **MIRROR**: `TEST_STRUCTURE`
- **VALIDATE**: 分母 0 のとき `0` を返すよう変えると落ちること

### Task 7: `src/ui/popup/popup-page.ts`

- **ACTION**: 新規。DOM 配線
- **IMPLEMENT**:
  - `SELECTORS` 定数 ＋ `find()`（`options-page.ts` と同形）
  - `let busy = false`（評価の保存中に来た操作を無視）
  - `renderCandidates(views)` — `<template>` を使わず `document.createElement` で組む
  - `renderPrecision` / `renderSettings` / `renderNotice`
  - `attachListeners()` — スライダー `input`/`change`、評価ボタンは **一覧のコンテナに委譲**（要素を作り直すため個別 addEventListener は消える）
  - `export async function init(): Promise<void>`
- **MIRROR**: `DOM_WIRING` / `BUSY_FLAG` / `LISTENER_FIRST`
- **GOTCHA**:
  - **`innerHTML` に候補の値を入れない。** ハンドルも記事 ID も外部由来。`textContent` と `createElement` を使う。Phase 7 で XSS を再評価する前に穴を作らない
  - **リスナーはイベント委譲にする。** 再検出のたびに `<li>` を作り直すので、個別に付けたリスナーは消える
  - `[hidden]` を殺さないこと（`options/index.html:56-60` の教訓。`display: flex` を足すと UA の `[hidden]{display:none}` に勝ってしまう）
  - リスナーを storage より先に付ける
- **VALIDATE**: `npx vitest run src/ui/popup/popup-page.test.ts`

### Task 8: `src/ui/popup/popup-page.test.ts`

- **ACTION**: Task 7 のテスト。`popup-state` をモックして DOM の性質だけを見る
- **MIRROR**: `options-page.test.ts` の `setupDom()` + `el()`
- **VALIDATE**: イベント委譲を個別 addEventListener に戻すと、再描画後のクリックが効かず落ちること

### Task 9: `src/ui/popup/index.html`

- **ACTION**: マークアップと CSS
- **IMPLEMENT**: `body { width: 520px }`、候補 `<ul id="candidates">`、`<input type="range">` 3 本、`#precision`、`#notice`、`#open-options`
- **GOTCHA**:
  - ポップアップの最大は 800×600。**`max-height` と `overflow-y: auto` を候補一覧に付ける**（候補が 16 件出た実測がある）
  - `.hidden[hidden] { display: none }` を必ず書く
- **VALIDATE**: `npm run build` ＋ 実機

### Task 10: `src/ui/popup/main.ts`

- **ACTION**: `init()` を呼ぶだけにする
- **MIRROR**: `src/ui/options/main.ts` をそのまま
- **VALIDATE**: `npm run build`

### Task 11: `src/test/setup.ts`

- **ACTION**: `chrome.action` のモックを足す
- **IMPLEMENT**: `action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() }`
- **GOTCHA**: `chrome.runtime.openOptionsPage` も足す（ポップアップから呼ぶ）
- **VALIDATE**: `npm run test`

### Task 12: 全体検証と実機確認

- **GOTCHA**: **ビルド成功は「正しく動く」を意味しない。** `dist/` の配線を必ず確認する
- **VALIDATE**: Manual Validation のチェックリスト

---

## Testing Strategy

### popup-state（純粋関数）

| Test | Input | Expected | Edge? |
|---|---|---|---|
| **未評価なら適合率は null** | `{}` | `{valid:0, falsePositive:0, ratio:null}` | ✅ |
| 妥当だけなら 1.0 | 妥当 2 件 | `ratio: 1` | |
| 混在なら比率 | 妥当 3 / 誤り 1 | `ratio: 0.75` | |
| **全部誤りなら 0（null ではない）** | 誤り 2 件 | `ratio: 0` | ✅ |
| 評価を候補に重ねる | 候補 2 / 評価 1 | 片方だけ verdict が付く | |
| 根拠 URL を組み立てる | `sharedItemIds` 2 件 | `https://qiita.com/{handle}/items/{id}` | |
| **429 が過ぎていれば案内しない** | `until` が過去 | `null` | ✅ |
| 429 の残り分数を出す | `now + 2520 秒` | 「42 分」を含む | |
| **`until` が null なら案内しない** | `null` | `null` | ✅ |
| 秒未満は切り上げる | `now + 30 秒` | 「1 分」 | ✅ |
| 設定が壊れていれば既定値 | sync に `{}` | `DEFAULT_SETTINGS` | ✅ |
| **再検出が API を叩かない** | 任意 | `fetch` が呼ばれない | ✅ |
| 閾値を上げると候補が減る | N=5 → N=20 | 件数が減る | |

### popup-page（jsdom）

| Test | Input | Expected | Edge? |
|---|---|---|---|
| 候補を件数ぶん描く | 2 件 | `li` が 2 つ | |
| **候補ゼロでも例外を投げない** | 0 件 | 「該当なし」＋最終スキャン時刻 | ✅ |
| 評価ボタンで保存する | 「妥当」クリック | `saveVerdict` が呼ばれる | |
| **再描画後もボタンが効く**（イベント委譲） | 再検出 → クリック | 保存される | ✅ |
| **保存中の 2 度押しを無視する** | 連打 | 保存は 1 回 | ✅ |
| スライダー `input` は保存しない | drag | `saveSettings` が呼ばれない | ✅ |
| スライダー `change` で保存する | 離す | `saveSettings` が 1 回 | |
| **storage が落ちてもリスナーは付く** | `loadPopupState` が reject | クリックが効く | ✅ |
| **ハンドルを textContent で入れる** | `<img onerror>` を含むハンドル | タグとして解釈されない | ✅ |
| 429 の案内を出す | notice あり | 文言とオプションへの導線 | |
| 429 が無ければ案内を隠す | `null` | `hidden` が付く | ✅ |

### scanner（変更分）

| Test | Input | Expected | Edge? |
|---|---|---|---|
| **保存された設定で検出する** | sync に N=2 | 既定値では出ない候補が出る | ✅ |
| 設定が無ければ既定値 | sync 空 | `DEFAULT_SETTINGS` | |
| 候補件数をバッジに出す | 2 件 | `setBadgeText({text:'2'})` | |
| 候補ゼロならバッジを空に | 0 件 | `text: ''` | ✅ |
| **429 中は `!`** | rateLimited | `text: '!'` | ✅ |
| バッジ更新が失敗してもスキャンは成功 | `setBadgeText` が reject | 例外なし | ✅ |

### Edge Cases Checklist

- [ ] 候補ゼロ / 評価ゼロ
- [ ] 候補 16 件（実測の最大クラスタ）でスクロールする
- [ ] `likeIndex` が空
- [ ] `storage.sync` が壊れている
- [ ] ポップアップを 2 枚開いて別々に評価する
- [ ] スライダーを端から端までドラッグする（sync の書き込み回数）
- [ ] 429 の直後にポップアップを開く

---

## Validation Commands

### Static Analysis
```bash
npm run typecheck
```
EXPECT: エラー 0。**Task 1 の直後は落ちる。それが変更箇所の一覧になる**

### Lint
```bash
npm run lint
```
EXPECT: 0 件。**`innerHTML` への値の埋め込みが無いこと**

### Unit Tests
```bash
npx vitest run src/ui src/background src/lib
```
EXPECT: 全通過

### Full Test Suite
```bash
npm run test
```
EXPECT: 全通過（223 件 + 新規）

### Coverage
```bash
npm run test -- --coverage
```
EXPECT: Statements 80% 以上。`popup-state.ts` は 95% 以上

### Build
```bash
npm run build
```

### dist の配線検証（CLAUDE.md 必須）
```bash
cat dist/service-worker-loader.js && grep -o 'getURL("[^"]*")' dist/assets/*loader*.js
```
EXPECT: SW と CS のローダーが**別々の正しいチャンク**を指す

### Manual Validation（実機）

- [ ] `dist/` を未パック拡張として読み込み直す
- [ ] `https://qiita.com/trend` を開く（スキャンが走る）
- [ ] **ツールバーのバッジに候補件数が出る**
- [ ] ポップアップを開くと候補が根拠リンクつきで出る
- [ ] **根拠リンクを押すと該当記事が新しいタブで開く**
- [ ] 「妥当」を押すと適合率が更新される
- [ ] ポップアップを閉じて開き直しても評価が残っている
- [ ] **N のスライダーを上げると候補が減り、下げると増える**
- [ ] **スライダーを動かしてもレート枠が減らない**（`rate-remaining` が変わらない）
- [ ] スライダーを変えた後にトレンドを開き直すと、新しい閾値で検出される
- [ ] 「トークンを設定する」で options ページが開く
- [ ] **エラー欄が空のまま**

---

## Acceptance Criteria

- [ ] Task 1〜12 完了
- [ ] 検証コマンドがすべて通る
- [ ] 型エラー 0、lint エラー 0
- [ ] **`src/detect/` の判定ロジックを変更していない**（`verdict` の削除のみ）
- [ ] **`logger.warn` / `logger.error` を新たに増やしていない**
- [ ] **候補の値を `innerHTML` に入れていない**
- [ ] 「不正」「スパム」と断定する文言が無い（設計上の約束 6）
- [ ] 実アカウント名・実 item_id がテストフィクスチャに無い
- [ ] **スライダーの操作で API を 1 本も叩かない**

## Completion Checklist

- [ ] `popup-state.ts` が `document` を 1 度も参照していない
- [ ] 評価が `Candidate` ではなく `feedback` に保存されている
- [ ] 閾値を変えても評価が消えない
- [ ] 適合率の分母 0 が `null` として区別されている
- [ ] リスナーがイベント委譲になっている
- [ ] リスナーが storage の読み込みより先に付く
- [ ] 閾値がすべて名前付き定数
- [ ] **各テストについて、直した箇所を戻すと落ちることを確認した**
- [ ] PRD の Phase 6 を `complete` に更新した

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **`Candidate.verdict` の削除が広範囲に波及する** | 高 | 低 | 型エラーとして全部出る。Task 1 を最初にやり、落ちた箇所を潰す |
| **再描画でリスナーが消える** | 中 | 中 | イベント委譲。専用テスト（再検出 → クリック）で固定 |
| **スライダーで `storage.sync` の書き込み上限に当たる** | 中 | 中 | 保存は `change` のみ。`input` は再計算だけ。専用テストあり |
| **ポップアップ 2 枚で評価が消し合う** | 低 | 中 | `saveVerdict` は読んで足して書く（全件上書きにしない） |
| **候補 16 件でポップアップが縦に溢れる** | 中 | 低 | 一覧に `max-height` + `overflow-y: auto` |
| **XSS**（ハンドルは外部由来） | 低 | **高** | `textContent` と `createElement` のみ。`innerHTML` を使わない。専用テストあり |
| **バッジが Phase 7 と衝突する** | 中 | 低 | 優先順位を先に決めておく（429 > 候補件数）。Phase 7 はこの規則に載せる |

## Notes

### この計画が触らないもの

`src/detect/` の判定ロジック、`src/dom/`、`src/api/`、options ページ。**判定は 1 本のまま**（設計上の約束 9）。

### OQ-16 がこの設計を決めている

**ミュートした著者はトレンドの DOM から消えるため、以後スキャンの入力に現れない。** 適合率フィードバックは **ミュートを実行する前** にしか取れない。だから Phase 6（評価）が Phase 8（一括ミュート）より先にあり、Phase 6 には**ミュートボタンを置かない**。

順序が逆だったら、押した瞬間に候補が視界から消えて評価できなくなっていた。

### 記事化の素材

- **評価を候補オブジェクトの中に持たせると、閾値を動かすたびに指標が消える。** 「候補」は再計算で作り直されるが「評価」は人間が積み上げた資産で、寿命が違う。**寿命の違うデータを同じ構造に入れてはいけない**
- **適合率の分母 0 を `0%` にするか `—` にするかで、Phase 9 の判断が変わる。** 「測ったら 0% だった」と「まだ測っていない」は別物
- **根拠リンクが無いと指標そのものが壊れる。** ユーザーが記事を読めなければ「妥当 / 誤り」は当てずっぽうになり、そこから出る適合率は無価値。**UI の手抜きが指標の妥当性を殺す**
- **UI の順序が測定可能性を決めていた。** ミュートボタンを候補一覧に置くと、押した瞬間に対象が視界から消えて評価できなくなる（OQ-16）

### 実装順序の推奨

`domain` → `storage` → `detector` → `scanner` → `popup-state` → `popup-page` → `html` → `main` → 検証。

**型を最初に変える。** 変更が必要な箇所が型エラーとして機械的に列挙されるので、探し漏れが起きない。
