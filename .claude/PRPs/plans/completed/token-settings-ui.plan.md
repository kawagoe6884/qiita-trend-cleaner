# Plan: トークン設定 UI（Phase 3）

## Summary

options ページにアクセストークンの入力・検証・保存・削除の UI を作る。トークンは**任意設定**であり、未設定でもライトモードで検出は動く。この UI の役割は「使えるようにする」ことではなく「**検出の射程を広げる**」手段を提供し、いまどちらのモードで動いているかをユーザーに明示することにある。

## User Story

As a Qiita Trend Guard を使う人,
I want いま拡張がどのモードで動いているかを知り、必要ならトークンを設定してフルモードに切り替えられること,
So that レート枠の制約を理解した上で、検出の射程を自分で選べる。

## Problem → Solution

**現在**: options ページは「設定項目は Phase 3 以降で追加します」というプレースホルダのみ。トークンを設定する手段が無く、`chrome.storage.local` を DevTools で直接編集するしかない。ユーザーは自分がライトモードで動いていることも知らない。

**完了後**: options ページでトークンを入力すると `GET /api/v2/authenticated_user` で疎通を検証し、成功すれば保存してフルモードに切り替わる。未設定時は「ライトモードで動作中」と、設定した場合に何が変わるかが明示される。

## Metadata

- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/qiita-trend-guard.prd.md`（改訂 4）
- **PRD Phase**: Phase 3 — トークン設定 UI
- **Estimated Files**: 6（CREATE 2 / UPDATE 4）
- **Depends**: Phase 2（complete）。Phase 4 の `verifyToken` / `storage.saveToken` を利用する（実装済み）
- **Parallel**: なし（Phase 4 は完了済み）

---

## UX Design

### Before

```
┌──────────────────────────────────────┐
│  Qiita Trend Guard                   │
│                                      │
│  設定項目は Phase 3 以降で追加します。 │
│                                      │
└──────────────────────────────────────┘
   ユーザーは自分がどのモードで動いて
   いるか知る手段がない
```

### After（未設定 = ライトモード）

```
┌────────────────────────────────────────────────┐
│  Qiita Trend Guard                             │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │ ● ライトモードで動作中                    │  │
│  │   トレンド 30 件の範囲で検出します。      │  │
│  │   1 時間あたり 60 リクエストまで。        │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  アクセストークン（任意）                       │
│  ┌──────────────────────────────────────────┐  │
│  │ ●●●●●●●●●●●●●●●●              [保存]     │  │
│  └──────────────────────────────────────────┘  │
│  設定すると著者の過去記事まで辿れるようになり、  │
│  1 時間あたり 1000 リクエストまで使えます。      │
│                                                │
│  → トークンの取得手順                          │
└────────────────────────────────────────────────┘
```

### After（設定済み = フルモード）

```
┌────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────┐  │
│  │ ● フルモードで動作中                      │  │
│  │   トレンド 30 件 ＋ 著者の過去記事。       │  │
│  │   1 時間あたり 1000 リクエストまで。       │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  設定済みのトークン: abcd••••••••wxyz           │
│                              [削除]            │
└────────────────────────────────────────────────┘
```

### Interaction Changes

| 触点 | Before | After | Notes |
|---|---|---|---|
| options ページ | プレースホルダ文言のみ | モード表示＋トークン入力 | 「何ができないか」ではなく「**何が広がるか**」を書く |
| トークン入力 | 手段なし | `type="password"` の入力欄 | 保存済みの値は**画面に戻さない**（マスク表示のみ） |
| 検証 | なし | 保存時に疎通確認 | 失敗理由を「無効」と「通信失敗」で区別する |
| 削除 | 手段なし | 削除ボタン | 確認ダイアログは置かない（再入力が容易なため） |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/lib/storage.ts` | 30-45 | `getToken` / `saveToken` / `clearToken` は**実装済み**。そのまま使う |
| P0 | `src/api/qiita-client.ts` | 160-175 | `verifyToken` は実装済みだが**戻り値の拡張が必要**（Task 1） |
| P0 | `src/ui/options/index.html` | 全 19 行 | 既存のスタイル（`system-ui` / `padding: 24px`）を踏襲する |
| P0 | `src/ui/options/main.ts` | 全 3 行 | 現状は logger 呼び出しのみ。ここを置き換える |
| P1 | `src/dom/selectors.ts` | 全体 | **DOM 依存を 1 ファイルに隔離する思想**。本フェーズも同じ形にする |
| P1 | `src/api/rate-budget.ts` | 15-55 | `RATE_LIMIT_ANON` / `RATE_LIMIT_AUTH` / `decideMode`。UI の文言に使う数値の出所 |
| P1 | `src/lib/storage.test.ts` | 15-45 | storage のテストの書き方（chrome モックは `setup.ts` 任せ） |
| P2 | `src/test/setup.ts` | 全 51 行 | jsdom + chrome モック。`document` は使えるが `fetch` は各テストで stub する |
| P2 | `.claude/PRPs/prds/qiita-trend-guard.prd.md` | 「トークンの有無によるモード」 | 文言の一次情報 |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| トークン発行 | `https://qiita.com/settings/applications` | 「個人用アクセストークン」を発行する。**読み取りのみなので `read_qiita` で足りる** |
| options ページ | [chrome.runtime.openOptionsPage](https://developer.chrome.com/docs/extensions/reference/api/runtime) | `options_page` は manifest に登録済み。追加設定は不要 |

### 実測結果（2026-08-19）

```
KEY_INSIGHT: GET /api/v2/authenticated_user は有効なトークンで HTTP 200 と 18 キーの
             User オブジェクトを返し、Rate-Limit ヘッダーが 1000 になる
APPLIES_TO: Task 1 の疎通検証
GOTCHA: 無効なトークンでは 401。ネットワーク断でも失敗する。
        現行の verifyToken は両者を boolean に潰しており、UI で区別できない

KEY_INSIGHT: options ページは拡張機能のオリジンで動き、host_permissions により
             qiita.com への fetch が許可される（CORS を回避できる）
APPLIES_TO: Task 5 の DOM 配線
GOTCHA: service worker を経由する必要はない。直接 fetch してよい

KEY_INSIGHT: scanner は毎回 storage からトークンを読む（キャッシュしない）
APPLIES_TO: 保存後の反映
GOTCHA: 保存後に service worker へ通知する必要はない。次のスキャンから自動で
        フルモードになる
```

---

## Patterns to Mirror

### NAMING_CONVENTION

```ts
// SOURCE: src/api/rate-budget.ts:14-21
export const RATE_LIMIT_ANON = 60;
export const RATE_LIMIT_AUTH = 1000;
export const RATE_SAFETY_MARGIN = 5;
// 定数: UPPER_SNAKE_CASE。マジックナンバーを UI に直書きしない

// SOURCE: src/feed/feed-fetcher.ts:20-22
export type FeedFetchOutcome =
  | { kind: 'unchanged' }
  | { kind: 'updated'; snapshot: FeedSnapshot; etag: string | null };
// 状態は kind による判別可能ユニオンで表す
```

### ERROR_HANDLING

```ts
// SOURCE: src/dom/selectors.ts:37-39
export function querySnackbarContainer(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SELECTORS.snackbarContainer);
}
// DOM 取得の失敗は null。例外を投げない
```

```ts
// SOURCE: src/api/qiita-client.ts:88-95
if (response.status === 401 || response.status === 403) {
  logger.warn('api auth rejected:', response.status, path);
  throw new QtgError(`api auth rejected (${String(response.status)})`);
}
// 想定内の失敗は logger.warn（logger.error は Chrome のエラーバッジを立てる）
```

### LOGGING_PATTERN

```ts
// SOURCE: src/ui/options/main.ts:3
logger.info('options page opened');
// UI 側も logger を通す。console 直呼びは ESLint エラー

// ★ トークンそのものを logger に渡さないこと。
//    現状のコードベースに token をログへ流している箇所は 1 つも無い
```

### STATE_AS_UNION（Phase 4 で確立した形）

```ts
// SOURCE: src/feed/feed-fetcher.ts:20-22
export type FeedFetchOutcome =
  | { kind: 'unchanged' }
  | { kind: 'updated'; snapshot: FeedSnapshot; etag: string | null };
// 呼び出し側は kind で分岐する。本フェーズの TokenState も同じ形にする
```

### TEST_STRUCTURE

```ts
// SOURCE: src/lib/storage.test.ts:16-24
describe('getToken', () => {
  it('未設定なら null を返す', async () => {
    // Arrange — setup.ts が beforeEach でストアを新品に差し替える
    // Act
    const token = await getToken();
    // Assert
    expect(token).toBeNull();
  });
});
// AAA をコメントで明示。テスト名は日本語で「何ができるか」
```

```ts
// SOURCE: src/api/qiita-client.test.ts:19-23
function stubFetch(body: unknown, init: ResponseInit = { status: 200 }): ReturnType<typeof vi.fn> {
  const mock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), init)));
  vi.stubGlobal('fetch', mock);
  return mock;
}
// fetch は各テストで stub する（setup.ts はモックしない）
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/api/qiita-client.ts` | UPDATE | `verifyToken` の戻り値を「無効」と「通信失敗」を区別できる形にする |
| `src/api/qiita-client.test.ts` | UPDATE | 上記に伴うテスト更新＋通信失敗ケースの追加 |
| `src/ui/options/token-form.ts` | CREATE | 状態遷移とメッセージ決定。**DOM に依存させずテスト可能にする** |
| `src/ui/options/token-form.test.ts` | CREATE | 状態遷移の検証 |
| `src/ui/options/index.html` | UPDATE | フォームとモード表示のマークアップ |
| `src/ui/options/main.ts` | UPDATE | DOM の配線のみ（ロジックは token-form.ts） |

## NOT Building

- **popup の表示更新** — Phase 6（候補 UI）の担当。今回は options のみ
- **「今すぐスキャン」ボタン** — `SCAN_NOW` は実装済みだが、押すとレート枠を 30 消費する。動作確認の導線は Phase 6 の設定 UI でまとめて設計する
- **パラメータ調整スライダー**（`minClusterSize` 等）— Phase 6
- **トークンの暗号化保存** — `storage.local` は拡張機能のサンドボックス内。同一拡張のコードからしか読めず、暗号化しても鍵を同じ場所に置くことになり実効性がない
- **トークンの自動再検証** — 保存時に 1 度検証すれば足りる。定期検証はレート枠の無駄
- **service worker への保存通知** — scanner は毎回 storage を読むため不要

---

## Step-by-Step Tasks

### Task 1: `verifyToken` の戻り値を拡張する

- **ACTION**: `src/api/qiita-client.ts` の `verifyToken` を更新する
- **IMPLEMENT**:
  ```ts
  /** トークン検証の結果。UI が理由で文言を出し分けるため boolean にしない */
  export type TokenVerification =
    | { ok: true }
    | { ok: false; reason: 'invalid' | 'network' };

  export async function verifyToken(token: string): Promise<TokenVerification> {
    try {
      await request('/authenticated_user', token);
      return { ok: true };
    } catch (error) {
      // 401/403 は QtgError（メッセージに auth rejected を含む）、
      // ネットワーク断も QtgError なので、判別は message で行う
      const invalid = error instanceof QtgError && error.message.includes('auth rejected');
      return { ok: false, reason: invalid ? 'invalid' : 'network' };
    }
  }
  ```
- **MIRROR**: STATE_AS_UNION（`FeedFetchOutcome` と同じ判別可能ユニオン）
- **IMPORTS**: 追加不要（`QtgError` は既に import 済み）
- **GOTCHA**:
  - **判別を message の部分一致で行うのは脆い。** `request()` 側の文言を変えると壊れる。実装時に `request()` のメッセージを確認すること（現状は `api auth rejected (401)`）
  - より堅牢にするなら `QtgError` に `status` を持たせる案もあるが、それは Phase 4 のコードに手を入れる範囲が広がる。**本フェーズでは message 判定に留め、脆さをコメントに残す**
- **VALIDATE**: `npm run typecheck` がエラー 0

### Task 2: `verifyToken` のテストを更新する

- **ACTION**: `src/api/qiita-client.test.ts` の `describe('verifyToken')` を書き換える
- **IMPLEMENT**:
  - 200 → `{ ok: true }`
  - 401 → `{ ok: false, reason: 'invalid' }`
  - fetch reject → `{ ok: false, reason: 'network' }`
  - 500 → `{ ok: false, reason: 'network' }`（サーバー側の問題であり、トークンは無効ではない）
- **MIRROR**: TEST_STRUCTURE（`stubFetch` ヘルパーは同ファイルに既存）
- **IMPORTS**: 変更なし
- **GOTCHA**: 既存の 2 テスト（`true` / `false` を期待）は**必ず落ちる**。書き換えを忘れないこと
- **VALIDATE**: `npx vitest run src/api/qiita-client.test.ts`

### Task 3: 状態遷移ロジック（`token-form.ts`）

- **ACTION**: `src/ui/options/token-form.ts` を作る
- **IMPLEMENT**:
  ```ts
  import { RATE_LIMIT_ANON, RATE_LIMIT_AUTH } from '../../api/rate-budget';

  /** 画面が取りうる状態 */
  export type TokenState =
    | { kind: 'light' }
    | { kind: 'full'; masked: string }
    | { kind: 'verifying' }
    | { kind: 'error'; message: string };

  /** 表示用の文言。数値は rate-budget の定数から作る（UI に直書きしない） */
  export interface ModeCopy {
    title: string;
    detail: string;
  }

  export function maskToken(token: string): string
  export function describeMode(state: TokenState): ModeCopy
  export async function loadState(): Promise<TokenState>
  export async function submitToken(raw: string): Promise<TokenState>
  export async function removeToken(): Promise<TokenState>
  ```
  - `maskToken`: 先頭 4 文字 ＋ `•` × 8 ＋ 末尾 4 文字。**12 文字以下なら全マスク**（短いトークンで中身が露出しないように）
  - `submitToken`: 空文字なら `error`、`verifyToken` が ok なら `saveToken` して `full`、失敗なら理由に応じた `error`
- **MIRROR**: STATE_AS_UNION、NAMING_CONVENTION（定数は `rate-budget` から import）
- **IMPORTS**:
  ```ts
  import { verifyToken } from '../../api/qiita-client';
  import * as storage from '../../lib/storage';
  import { RATE_LIMIT_ANON, RATE_LIMIT_AUTH } from '../../api/rate-budget';
  ```
- **GOTCHA**:
  - **入力値は `trim()` してから扱う。** コピペで前後に空白や改行が混ざるのが最も多い失敗
  - **保存に成功しても生のトークンを返さない。** `masked` だけを状態に載せる
  - **`logger` にトークンを渡さない**（コードベース全体で 0 件を維持する）
  - このファイルは `document` を参照しないこと。DOM は `main.ts` の責務
- **VALIDATE**: `npm run test`

### Task 4: `token-form.test.ts`

- **ACTION**: `src/ui/options/token-form.test.ts` を作る
- **IMPLEMENT**:
  - `maskToken`: 長いトークンで先頭と末尾だけ残る／短いトークンは全マスク／**元の値が結果に含まれない**
  - `loadState`: 未設定なら `light`、設定済みなら `full` かつ `masked` が生値でない
  - `submitToken`: 空文字・空白のみで `error`（fetch を呼ばない）／検証成功で `full` かつ storage に保存される／401 で `error`（**保存しない**）／ネットワーク失敗で `error` かつ文言が 401 と異なる
  - `removeToken`: `light` に戻り storage から消える
  - `describeMode`: 文言に 60 と 1000 が含まれる（定数由来であること）
- **MIRROR**: TEST_STRUCTURE
- **IMPORTS**: `import { describe, it, expect, vi } from 'vitest';`
- **GOTCHA**: `verifyToken` は実 fetch を行うので `vi.mock('../../api/qiita-client')` で差し替える。`vi.mock` はファイル先頭に巻き上げられるため、ファクトリ内で外部変数を参照しない
- **VALIDATE**: `npm run test`

### Task 5: マークアップ（`index.html`）

- **ACTION**: `src/ui/options/index.html` を UPDATE する
- **IMPLEMENT**:
  - `<section id="mode">` — モード表示（title / detail の 2 要素）
  - `<form id="token-form">` — `<input type="password" id="token" autocomplete="off">` ＋ 保存ボタン
  - `<p id="message">` — エラー・成功の表示（`role="status"` と `aria-live="polite"`）
  - `<section id="saved">` — マスク表示と削除ボタン（設定済みのときだけ表示）
  - `<details>` でトークン取得手順（`https://qiita.com/settings/applications` へのリンク、`read_qiita` スコープで足りる旨）
- **MIRROR**: 既存 `index.html` のスタイル（`system-ui` / `margin: 0` / `padding: 24px`）を踏襲。CSS は同ファイル内の `<style>` に置く
- **IMPORTS**: なし
- **GOTCHA**:
  - **`type="password"` と `autocomplete="off"` を必ず付ける。** ブラウザのパスワードマネージャに拾わせない
  - **`aria-live="polite"` を message に付ける。** 検証結果が視覚以外にも伝わるようにする（`selectors.ts` で Qiita 自身が使っている手法と同じ）
  - スクリプトは `<script type="module" src="./main.ts">`。@crxjs が解決する
  - **エントリの basename を `index.ts` にしない**という約束は HTML には及ばない（`index.html` は既存のまま）
- **VALIDATE**: `npm run build` 後に `dist/src/ui/options/index.html` が生成される

### Task 6: DOM 配線（`main.ts`）

- **ACTION**: `src/ui/options/main.ts` を UPDATE する
- **IMPLEMENT**:
  ```ts
  function render(state: TokenState): void  // 状態を DOM に反映するだけ
  // DOMContentLoaded で loadState() → render()
  // form の submit で submitToken() → render()
  // 削除ボタンで removeToken() → render()
  ```
- **MIRROR**: ERROR_HANDLING（要素が取れなければ `null` を返して何もしない）、LOGGING_PATTERN
- **IMPORTS**:
  ```ts
  import { logger } from '../../lib/logger';
  import { loadState, submitToken, removeToken, describeMode } from './token-form';
  import type { TokenState } from './token-form';
  ```
- **GOTCHA**:
  - **`form` の `submit` で `event.preventDefault()` を呼ぶ。** 忘れるとページがリロードして状態が飛ぶ
  - **送信中はボタンを `disabled` にする。** 二重送信でレート枠を無駄に消費する
  - **検証成功後に input の値をクリアする。** 画面に生のトークンを残さない
  - 要素の取得は `document.querySelector` で、取れなければ `logger.warn` して中断（例外を投げない）
- **VALIDATE**: `npm run build` ＋ 実機確認

### Task 7: 統合検証

- **ACTION**: ビルドして実機で確認する
- **IMPLEMENT**: 下記 Validation Commands の Level 3〜4
- **GOTCHA**: **ビルド成功は「正しく動く」を意味しない。** Phase 2 でも Phase 4 でも、全検証通過後に実機で壊れていた。options ページを実際に開いて確認すること
- **VALIDATE**: 未設定→ライトモード表示、トークン入力→フルモード、削除→ライトモードに戻る

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| マスクが元の値を漏らさない | 40 文字のトークン | 先頭 4 ＋ 末尾 4 のみ、生値を含まない | ✅ |
| 短いトークンは全マスク | 8 文字 | 中身が 1 文字も出ない | ✅ |
| 空文字は検証しない | `''` | `error`、**fetch 未呼び出し** | ✅ |
| 空白のみは検証しない | `'   '` | `error`、fetch 未呼び出し | ✅ |
| 前後の空白を落とす | `' abc '` | `abc` で検証される | ✅ |
| 検証成功で保存 | 有効トークン | `full`、storage に保存 | |
| 401 では保存しない | 無効トークン | `error`、**storage は空のまま** | ✅ |
| 通信失敗と無効を区別 | reject | `error` かつ 401 と別の文言 | ✅ |
| 削除でライトに戻る | — | `light`、storage から消える | |
| 文言が定数由来 | — | 60 と 1000 を含む | |

### Edge Cases Checklist

- [x] 空入力（空文字・空白のみ）
- [x] 最大サイズ（長いトークンのマスク）
- [x] 不正な型 — N/A（入力は常に string）
- [ ] 並行アクセス — **該当なし**。options ページは単一タブ想定
- [x] ネットワーク失敗
- [x] 権限拒否（401）

### カバレッジ方針

**80% 以上**を合格条件にする。`main.ts`（DOM 配線のみ）は対象外でよい。ロジックは `token-form.ts` に寄せてあるため、そちらで達成する。

---

## Validation Commands

### Level 1: 静的解析

```bash
npm run typecheck
```
EXPECT: エラー 0

```bash
npm run lint
```
EXPECT: エラー 0

### Level 2: ユニットテスト

```bash
npm run test
```
EXPECT: 全通過（既存 86 ＋ 新規分）

### Level 3: ビルドと配線検証

```bash
npm run build
```
EXPECT: 成功

```bash
cat dist/service-worker-loader.js
```
EXPECT: `service-worker.ts-<hash>.js` を指す

```bash
grep -o 'getURL("[^"]*")' dist/assets/*loader*.js
```
EXPECT: `content-script.ts-<hash>.js` を指す

> Phase 2 のチャンク名衝突の再発チェック。UI を追加してもここは崩れないはずだが、毎回確認する。

### Level 4: 実機確認

1. `chrome://extensions` で `dist/` を再読み込み
2. 拡張の「詳細」→「拡張機能のオプション」を開く
3. **未設定の状態**: 「ライトモードで動作中」と、トレンド 30 件・60 リクエストの説明が出る
4. **無効なトークン**（例: `invalid-token-value`）を入力 → 「トークンが無効です」と出て**保存されない**
5. **有効なトークン**を入力 → 「フルモードで動作中」に切り替わり、マスク表示になる
6. DevTools の Application → Extension Storage で `token` が保存されていることを確認
7. **削除**→ ライトモードに戻り、storage から `token` が消える
8. ページをリロード → 状態が保持されている

### Manual Validation

- [ ] input が `type="password"` で、入力中の値が伏せられる
- [ ] 保存済みトークンが**画面に生で表示されない**
- [ ] 保存ボタンが送信中に `disabled` になる（二重送信でレート枠を消費しない）
- [ ] コンソールにトークンが出力されていない
- [ ] 検証で 401 と通信失敗の文言が異なる

---

## Acceptance Criteria

- [ ] Task 1〜7 完了
- [ ] Validation Level 1〜4 がすべて通過
- [ ] カバレッジ 80% 以上（`main.ts` を除く）
- [ ] 型エラー 0 / lint エラー 0
- [ ] **PRD の Success signal**: トークンを入力すると疎通確認が通りフルモードに切り替わる。未設定時は「ライトモードで動作中。設定すると検出の射程が広がる」ことが UI に明示される

## Completion Checklist

- [ ] コードが既存パターンに従っている（判別可能ユニオン、logger 経由、`import type`、AAA テスト）
- [ ] **トークンを `logger` に渡していない**（コードベース全体で 0 件を維持）
- [ ] **保存済みトークンを画面に生で戻していない**
- [ ] `token-form.ts` が `document` を参照していない（DOM 依存は `main.ts` に隔離）
- [ ] レート枠の数値を UI に直書きせず `rate-budget` の定数から作っている
- [ ] スコープ外の実装が混入していない（popup / スライダー / 手動スキャン）

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **`verifyToken` の理由判定が message の部分一致で脆い** | **Medium** | Medium | `request()` の文言を変えたら壊れる。Task 1 の GOTCHA に明記し、テストで 401 と reject の両方を固定する |
| トークンが画面やログに露出する | Low | **High** | `type="password"`、マスク表示、検証後の input クリア、logger へ渡さない。Completion Checklist で確認 |
| 保存後にフルモードへ切り替わらない | Low | Medium | scanner は毎回 storage を読む設計（Phase 4 で確認済み）。通知は不要 |
| 二重送信でレート枠を消費 | Medium | Low | 送信中はボタンを `disabled` にする |
| トークン取得手順の URL が変わっている | Low | Low | 実装時に実機で `https://qiita.com/settings/applications` を開いて確認する |

## Notes

### なぜロジックを `token-form.ts` に分けるか

`main.ts` に全部書くと、DOM に依存してテストが書けない。Phase 2 で `selectors.ts` に DOM の知識を隔離したのと同じ思想で、**状態遷移とメッセージ決定を DOM から切り離す**。これにより「401 では保存しない」のような重要な性質をユニットテストで固定できる。

### トークンを暗号化しない理由

`chrome.storage.local` は拡張機能のサンドボックス内にあり、同一拡張のコードからしか読めない。暗号化しても復号鍵を同じ storage に置くことになり、実効的な保護にならない。PRD の「`storage.sync` に置かない」（同期による漏出面の拡大を避ける）は既に守られている。

### 本フェーズが Phase 5 に渡すもの

Phase 5（検出エンジン）は `storage.getToken()` の結果を直接は見ない。`scanner` がモードを決めてインデックスを作るため、**Phase 3 の成果は「フルモードのインデックスが手に入るようになる」という形で間接的に効く**。両フェーズの結合点は storage のキーだけである。

### 記事化の素材（Phase 10 向け）

- **「トークン必須」という前提が実測で覆り、UI の役割が『使えるようにする』から『射程を広げる』に変わった**。改訂 3 の UI 文言は「何ができないか」を説明する設計だった
- 検証の失敗理由を boolean に潰すと UI が嘘をつく（通信断を「トークンが無効」と表示してしまう）

---

*Generated: 2026-08-19*
*Source PRD: `.claude/PRPs/prds/qiita-trend-guard.prd.md` — Phase 3*
