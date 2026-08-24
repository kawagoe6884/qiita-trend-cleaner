# Plan: 「妥当」と同時にミュートする（Phase 8）

## Summary

ポップアップで「妥当」を押したときに、開いているトレンドページのカードから **Qiita 公式のミュートメニューを自動操作**する。実行は既定でオフで、「ミュートも同時に行う」チェックを入れたときだけ動く。**起動は message passing で行う**（`storage.onChanged` ではない）ので、既に「妥当」を押してある候補をもう一度押してもやり直せる。

## User Story

As a Qiita のトレンドを毎日開く読者,
I want 候補を「妥当」と判断した瞬間に、その著者を Qiita 側でもミュートしてほしい,
So that 拡張が入っていない環境でもトレンドから消え、手動でミュートし続ける手間が無くなる.

## Problem → Solution

**現在**: 「妥当」を押すと拡張がカードを隠す（Phase 7）。だが Qiita 側は何も変わらないので、**拡張を切ると全部戻ってくる**し、スマホなど別環境には効かない。ミュートは三点メニューから 1 人ずつ手で押すしかない。

**望む状態**: 「妥当」を押す → 拡張が三点メニューを開き「投稿ユーザーをミュート」だけを押す → Snackbar で完了を確認 → カードを隠す。ミュートは `https://qiita.com/settings/mutes` でユーザー自身が一覧・解除できる。

## Metadata

- **Complexity**: **Large**（13 ファイル・新規 1 モジュール・新しい経路が 2 本）
- **Source PRD**: `.claude/PRPs/prds/qiita-trend-guard.prd.md`
- **PRD Phase**: Phase 8 — 一括ミュート実行
- **Estimated Files**: 13（実装 8 / テスト 5）

---

## ユーザー確定事項（2026-08-24）

**逐語の要望**: 「**「ミュートも同時に行う。」があれば良さそうに考えた。`https://qiita.com/settings/mutes`でユーザー自身が確認できる。**」

| 論点 | 決定 | 却下した案 |
|---|---|---|
| **実行の起点** | **A: 「妥当」と同時（設定でオン/オフ）** | B: 候補ごとのミュートボタン、C: 一覧から一括、A+C 併用 |
| **画面に居ない著者** | **スキップして結果に出す** | ユーザーページ (`qiita.com/{handle}`) を開いて実行 |

**PRD の Success signal と食い違う点を明記する。** PRD には「候補一覧から **1 クリックで複数件**のミュートが完了し」とあるが、これは案 C の記述である。ユーザーは A を選んだので、**この計画は複数件の一括実行を作らない。**実装後に PRD の Success signal を A に合わせて書き換えること（Task 13）。

---

## 影響範囲の要約

**インポーター / 呼び出し元**

| モジュール | 呼び出し元 | 依存先 |
|---|---|---|
| `src/dom/muter.ts`（新規） | `src/content/content-script.ts` のみ | `dom/selectors` / `dom/trend-reader` / `dom/hider` / `types/domain` |
| `readTrendCards`（`trend-reader.ts` に新設） | `dom/hider.ts` / `dom/muter.ts` | 同ファイル内の `findCard` / `readTrendItems` |
| `revealCard` / `concealCard`（`hider.ts` に新設） | `dom/muter.ts`（`concealCard` は `hider.ts` 内からも） | — |
| `storage.ts` の新関数 4 つ | `ui/popup/popup-state.ts` / `ui/popup/popup-page.ts` | `chrome.storage.local` |

依存は一方向で**循環しない**（`muter` → `hider` → `trend-reader` → `selectors`）。

**影響する外部 API**

| API | 種別 | 権限 |
|---|---|---|
| `chrome.tabs.query({ url })` | **新規使用** | `host_permissions` で足りる。**`tabs` 権限は追加しない** |
| `chrome.tabs.sendMessage(tabId, msg)` | **新規使用** | 同上 |
| `chrome.runtime.onMessage`（content script 側） | **新規リスナー** | 不要 |
| `chrome.storage.local` | 既存 | `storage` |
| Qiita の HTTP API | **1 本も増えない** | — |

**データスキーマ（新規）**

```ts
type MuteOutcome = 'muted' | 'not-on-page' | 'menu-unavailable' | 'timeout' | 'no-trend-tab' | 'unreachable';
interface MuteRecord { outcome: MuteOutcome; at: IsoDateTime }
type MuteLog = Record<AccountHandle, MuteRecord>;
// LocalState に追加:  muteOnValid?: boolean（既定 false） / muteLog?: MuteLog
// QtgRequest に追加:  { type: 'MUTE_AUTHOR'; handle: AccountHandle }
// QtgResponse に追加: { type: 'MUTE_RESULT'; handle: AccountHandle; outcome: MuteOutcome }
```

---

## UX Design

### Before

```
┌── ポップアップ ────────────────┐        ┌── トレンドページ ──────┐
│ 候補 2 件 / 適合率 —（未評価）  │        │ ┌────────────────┐ │
│                                │        │ │ 記事 A  著者 X  ⋯│ │
│ ┌ example-author-1 ──────────┐ │        │ └────────────────┘ │
│ │ 17 アカウントが 2 記事に共通 │ │        │ ┌────────────────┐ │
│ │ 根拠: 記事1 記事2           │ │        │ │ 記事 B  著者 Y  ⋯│ │
│ │ [妥当] [誤り]  ←── 押す     │ │        │ └────────────────┘ │
│ └────────────────────────────┘ │        └───────────────────┘
└────────────────────────────────┘                  ↓
                                            カードが消えるだけ。
                                    Qiita 側は何も変わっていないので、
                                    **拡張を切ると全部戻る**
```

### After

```
┌── ポップアップ ──────────────────────────┐
│ 候補 2 件 / 適合率 —（未評価）            │
│                                          │
│ ☑ 「妥当」と同時にミュートも行う          │  ← 既定はオフ
│   ミュートは 設定 > ミュート で解除できます │
│                                          │
│ ┌ example-author-1 ────────────────────┐ │
│ │ 17 アカウントが 2 記事に共通           │ │
│ │ 根拠: 記事1 記事2                     │ │
│ │ ミュートしました       ← 結果がここに出る │ │
│ │ [妥当] [誤り]                         │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
        │ chrome.tabs.sendMessage
        ↓
┌── トレンドページ（content script）──────────────────┐
│  1. 著者のカードを探す（隠れていても対象）             │
│  2. 隠れていたら **一時的に表示に戻す**                │
│  3. [aria-label="ユーザーを管理"] をクリック          │
│  4. aria-controls が指す <ul role="menu"> を辿る      │
│  5. 「投稿ユーザーをミュート」に **完全一致** する      │
│     項目だけをクリック（無ければ何もしない）           │
│  6. Snackbar の「ミュートが完了しました」を待つ         │
│  7. カードを隠し直す                                  │
└──────────────────────────────────────────────────────┘
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| ポップアップの「妥当」 | 評価を保存 → カードを隠す | 評価を保存 → **ミュート実行** → カードを隠す | チェックがオンのときだけ |
| 「妥当」の押し直し | 何も起きない（`onChanged` が発火しない） | **もう一度ミュートを試みる** | これがリトライ手段。専用のリトライキューは持たない |
| 「誤り」 | 変更なし | 変更なし | ミュートは一切しない |
| 候補の行 | 著者 / 統計 / スコア / 根拠 / ボタン | ＋ **ミュートの結果行**（実行したものだけ） | 未実行なら行ごと出さない |
| トレンドページ | 変化なし | ミュート時だけ一瞬メニューが開く | ユーザーへのフィードバックとして意図的に見せる |

---

## Mandatory Reading

| 優先 | ファイル | 行 | なぜ |
|---|---|---|---|
| **P0** | `src/dom/hider.ts` | 全体 | **DOM を書き換える唯一の既存モジュール。**`display` の扱い・dataset マーカー・フェイルセーフの書き方をそのまま踏襲する |
| **P0** | `src/dom/selectors.ts` | 1-93 | セレクタの唯一の置き場。`SNACKBAR_TEXT` と `readSnackbarMessage` は **Phase 2 で既に実装済み**（今回は使うだけ） |
| **P0** | `src/dom/trend-reader.ts` | 76-134 | `findCard` の祖先探索。今回 `readTrendCards` を切り出す元 |
| **P0** | `src/ui/popup/popup-page.ts` | 320-437 | `handleVerdict` / `busy` フラグ / イベント委譲。ここに 1 分岐足す |
| **P1** | `src/content/content-script.ts` | 88-161 | `shownByUser` / `applyHiding` / `watchFeedback`。ミュートと非表示の競合はここで解く |
| **P1** | `src/lib/storage.ts` | 116-160 | `getFeedback` / `saveVerdict` の書き方。`getMuteLog` / `recordMuteOutcome` はこの形をそのまま真似る |
| **P1** | `src/types/domain.ts` | 1-20, 44-70 | 型の置き場。`MuteOutcome` はここに置く（`dom/muter.ts` ではない） |
| **P1** | `src/test/setup.ts` | 36-70 | chrome モック。`tabs.query` / `tabs.sendMessage` を足す |
| **P2** | `src/dom/hider.test.ts` | 1-40 | フィクスチャ（`card(n)` ヘルパー）。muter のテストでも同じ形で使う |
| **P2** | `src/dom/selectors.test.ts` | 1-58 | **ハッシュクラス禁止の機械検査**。`SELECTORS` に足す値はこれを通る必要がある |
| **P2** | `src/ui/popup/index.html` | 174-215 | チェックボックスを差し込む位置 |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| `chrome.tabs.query` の `url` フィルタ | Chrome Extensions API リファレンス | **`tabs` 権限は不要。**`host_permissions` が対象 URL に一致していれば `url` フィルタが効き、`tab.url` も返る。本拡張は `https://qiita.com/*` を持っている |
| `chrome.runtime.onMessage` の非同期応答 | Chrome Extensions API リファレンス | MV3 の Chrome では **Promise を返しても効かない。**`sendResponse` を後で呼び、リスナーは同期的に `return true` する。**扱わないメッセージでは `true` を返さないこと**（チャネルを開いたままにすると他のリスナーの応答が捨てられる） |
| React の `useId` | React 18 以降 | 生成 ID は `:r1:` のようにコロンを含み、**`#id` の CSS セレクタでは書けない。**`aria-controls` の値で要素を引くときは `getElementById` か、`[role="menu"]` を列挙して `id` を比較する |

**上記以外の外部調査は不要** — ミュートメニューの DOM は OQ-9 で実測済み（PRD 93 行目）。Snackbar 側は Phase 2 で実装とテストが揃っている。

---

## 実測済みの DOM（OQ-9 / 2026-08-24・PRD 93 行目より）

```
<article>                                        ← カードのルート
  <a href="https://qiita.com/{handle}/items/{id}" aria-hidden="true">  ← カード全体リンク
  <h2><a href="https://qiita.com/{handle}/items/{id}">タイトル</a></h2> ← 2 本目
  <time datetime="2026-08-17T17:44:41Z">
  <button aria-haspopup="dialog"
          aria-label="ユーザーを管理"
          aria-expanded="false"          ← 開閉状態
          aria-controls="{React の生成 ID}">   ← <ul role="menu"> の id
    <span class="material-symbols-outlined">more_horiz</span>
  </button>
  <ul role="menu" id="{同じ ID}">
    <li role="menuitem">投稿ユーザーをフォロー</li>
    <li role="menuitem">投稿ユーザーをブロック</li>   ← ⚠️ ミュートの直上
    <li role="menuitem">投稿ユーザーをミュート</li>
  </ul>
</article>
```

**⚠️ 危険な選択肢が安全な選択肢の真上にある。**ブロックを誤爆すると native `alert()` が出て content script から閉じられず、解除用の一覧 URL も存在しないので回収できない（PRD 641 行目 / 設計上の約束 7）。**順序・インデックス・部分一致で選ばない。テキスト完全一致だけで特定する。**

**副次的な安全性**: 既にミュート済みのユーザーはメニューの文言が変わる（Snackbar に「ミュートの解除が完了しました」があることから、項目自体がトグルになっている）。完全一致にしておけば、**解除側の文言を知らなくても誤って解除することが原理的に起きない。**「一致しなければ何もしない」で閉じる。

**DevTools からコピーした HTML には自分の環境が混ざる。**実測には `fdprocessedid` が付いていたが、これはパスワードマネージャー系の拡張が付けた属性で Qiita のものではない（CLAUDE.md）。セレクタに使わない。

---

## Patterns to Mirror

### NAMING_CONVENTION

```ts
// SOURCE: src/dom/hider.ts:24-48
import { SELECTORS, HIDDEN_MARKER, HIGHLIGHT_MARKER, NOTICE_ID } from './selectors';
import { readTrendItems, findCard } from './trend-reader';
import type { AccountHandle, FeedbackLog } from '../types/domain';

/** dataset のキー（qtgHidden）に対応する属性セレクタ */
const HIDDEN_ATTR_SELECTOR = '[data-qtg-hidden="true"]';

/** 隠した結果。呼び出し側がログと通知に使う */
export interface HideResult {
  hidden: number;
  authors: AccountHandle[];
}
```

ファイル名は動詞由来の名詞（`hider` / `trend-reader` / `scanner`）。型は `PascalCase`、定数は `UPPER_SNAKE_CASE`、関数は `camelCase`。**`export` する関数には必ず JSDoc を付け、「なぜそうするか」を書く。**

### ERROR_HANDLING（DOM 層 — 例外を投げない）

```ts
// SOURCE: src/dom/trend-reader.ts:86-95
export function findCard(link: Element): Element | null {
  let current: Element | null = link.parentElement;
  for (let depth = 0; depth < MAX_CARD_DEPTH && current !== null; depth += 1) {
    if (current.querySelectorAll(SELECTORS.trendItemLink).length > LINKS_PER_CARD) return null;
    if (current.querySelector(SELECTORS.trendItemTime) !== null) return current;
    current = current.parentElement;
  }
  return null;
}
```

**設計上の約束 3**: DOM 取得の失敗は例外を投げず `null` を返す。今回の muter は `null` の代わりに **`MuteOutcome` の値**を返す（何が起きたかを呼び出し側が UI に出すため）が、**例外を投げない**という性質は同じ。

### LOGGING_PATTERN

```ts
// SOURCE: src/content/content-script.ts:128-137
    const result = hideJudgedAuthors(feedback);
    if (result.hidden > 0) {
      logger.info('hidden:', result.hidden, 'authors:', result.authors.length);
    }
    refreshNotice();
  } catch (error) {
    // storage が読めなくても、ページの表示そのものは壊さない。
    // 隠せないだけなので想定内（設計上の約束 11）
    logger.debug('failed to apply hiding:', error);
  }
```

**設計上の約束 4 / 11**: `console` を直接呼ばない。**想定内の失敗は `logger.debug`。**Chrome は `console.warn` も `chrome://extensions` のエラー欄に集める。

今回の水準:

| 事象 | 水準 | 理由 |
|---|---|---|
| ミュート成功 | `logger.info('muted:', handle)` | ユーザーの操作の結果。1 回につき 1 行 |
| カードが画面に無い | `logger.debug` | **想定内。**トレンドが入れ替われば普通に起きる |
| メニューが見つからない | `logger.debug` | **想定内。**既にミュート済みならこれになる |
| Snackbar が来ない | `logger.debug` | 想定内。ユーザーは `settings/mutes` で確認できる |
| トレンドタブが無い | `logger.debug` | ユーザーの状態であって拡張の不具合ではない |

**`warn` / `error` は 1 つも増やさない。**（受け入れ基準は「想定内の失敗を載せない」— 絶対形で「増やさない」と書くと正しい実装が基準に反する、という CLAUDE.md の教訓に従う）

### REPOSITORY_PATTERN（storage）

```ts
// SOURCE: src/lib/storage.ts:122-146
export async function getFeedback(): Promise<FeedbackLog> {
  const raw = await readRaw();
  const stored = raw.feedback;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const log: FeedbackLog = {};
  // Object.entries(object) の値は any になる。unknown に落としてから絞ると、
  // 知らない値が FeedbackLog に紛れ込むのを型で止められる
  for (const [handle, value] of Object.entries(stored as Record<string, unknown>)) {
    if (value === 'valid' || value === 'false_positive') log[handle] = value;
  }
  return log;
}

export async function saveVerdict(handle: AccountHandle, verdict: Verdict): Promise<FeedbackLog> {
  const feedback = { ...(await getFeedback()), [handle]: verdict };
  await chrome.storage.local.set({ feedback });
  return feedback;
}
```

**1 件だけ壊れていても全体を捨てない。読んで足して書く（全件上書きにしない）。書いた後の全体を返す**（呼び出し側が読み直さずに済む）。`recordMuteOutcome` はこの 3 つをそのまま守る。

### SERVICE_PATTERN（popup-state — DOM を触らない）

```ts
// SOURCE: src/ui/popup/popup-state.ts:277-279
/** 判定を記録し、更新後の適合率を返す。saveVerdict の戻り値を使い、読み直さない */
export async function recordVerdict(handle: AccountHandle, verdict: Verdict): Promise<Precision> {
  return precisionOf(await storage.saveVerdict(handle, verdict));
}
```

`popup-state.ts` は **`document` を一切参照しない。**文言を作る関数（`describeMode` / `describeCall` / `describeEmpty` / `describeCoAuthors`）はすべてここにあり、ユニットテストで固定されている。`describeMuteOutcome` もここに置く。

### TEST_STRUCTURE

```ts
// SOURCE: src/dom/hider.test.ts:13-25, 41-50
/**
 * 1 カード分の骨格。実測どおり **記事リンクを 2 本** 持たせる
 * （タイトル無しとタイトル付き）。1 本にすると二重処理のテストが成立しない。
 *
 * フィクスチャは合成値のみ。実アカウント名・実 item_id は使わない。
 */
function card(n: number, author = `example-author-${String(n)}`): string {
  const itemId = `0123456789abcdef${String(n).padStart(4, '0')}`;
  const url = `https://qiita.com/${author}/items/${itemId}`;
  return `<div class="card"><a href="${url}"></a><time datetime="2026-08-18T10:00:00Z">2026年08月18日</time><a href="${url}">タイトル ${String(n)}</a></div>`;
}

describe('hideJudgedAuthors', () => {
  it('妥当と評価された著者のカードを隠す', () => {
    // Arrange
    setupCards(card(1), card(2));
    const feedback: FeedbackLog = { 'example-author-1': 'valid' };
    // Act
    const result = hideJudgedAuthors(feedback);
    // Assert
    expect(result.hidden).toBe(1);
```

AAA コメント（`// Arrange` / `// Act` / `// Assert`）を明示。テスト名は日本語で振る舞いを書く。**フィクスチャに実アカウント名を使わない**（記事化の絶対制約）。

### TEST_STRUCTURE（content script — モジュール再読み込み）

```ts
// SOURCE: src/content/content-script.test.ts:41-51
async function bootContentScript(pathname = '/trend'): Promise<void> {
  window.history.replaceState({}, '', pathname);
  vi.resetModules();
  await import('./content-script');
  await vi.waitFor(() => {
    expect(sendMessageMock()).toHaveBeenCalled();
  });
  await Promise.resolve();
  await Promise.resolve();
}
```

トップレベルに副作用のあるモジュールは `vi.resetModules()` + 動的 import。**`chrome` は `setup.ts` が各テスト前に用意するので、モジュールのトップレベルではまだ未定義**（関数に包んで参照する）。

---

## Architecture Decisions（実装前に必ず読む）

### AD-1 — ミュートの起動は message passing。`storage.onChanged` を使わない ★最重要

CLAUDE.md の教訓がそのまま当たる:

> **storage の変更通知は「操作の通知」ではない。**評価が既に valid なので値が変わらず、`chrome.storage.onChanged` が発火しない。**ユーザーの操作を storage の変化で代用すると、冪等な操作が消える。**

**既に「妥当」を押してある候補（実機で 2 件ある）をもう一度押しても `onChanged` は発火しない。**そこにミュートをぶら下げると、その 2 件は永久にミュートされない。

| 種類 | 経路 | 理由 |
|---|---|---|
| **非表示**（状態の同期） | `chrome.storage.onChanged` | 「いま valid なものが隠れている」という**状態**。値が同じなら再適用は不要 |
| **ミュート**（操作） | `chrome.tabs.sendMessage` | 「いま押した」という**イベント**。値が同じでも実行されなければならない |

**この分離が、リトライ機構を持たずに済ませる根拠でもある。**失敗したらもう一度「妥当」を押せばやり直せる。

### AD-2 — 1 つのタブにだけ送る。storage 経由のコマンドにしない

`storage.local` に `{ muteRequest: { handle, requestedAt } }` を書けば `tabs` API を使わずに済む。**だが採らない。**

トレンドタブが 2 枚開いていると **両方が実行する**。片方がミュートした直後、もう片方は自分の（古い）DOM でメニューを開き、React が再描画していなければ「投稿ユーザーをミュート」をもう一度押す。**トグルなので解除される。**`chrome.tabs.sendMessage` で 1 タブに限定すれば、この経路が原理的に無くなる。

（Phase 4b で「契機を変えると、変えていないコードの前提が壊れる」— 2 タブ開くだけで `runScan` が重なった — と同じ形。今回は先に潰す。）

### AD-3 — Phase 7 の非表示と競合する。カードを一時的に戻してから操作する

「妥当」を押した瞬間、**2 つのことが同時に走る**:

1. `storage.local.feedback` が変わる → content script の `onChanged` → `applyHiding()` → カードが `display: none`
2. popup が `MUTE_AUTHOR` を送る → content script がカードのメニューを開く

**順序は保証されない。**（storage の書き込みが先に完了するので 1 が先になりやすい）

jsdom でも実機でも、`display: none` の要素に `.click()` を撃つとイベント自体は飛ぶ。**だがそれに賭けない。**メニューが React のポータルではなくカードの中に描画される場合、開いたメニューごと隠れている状態で操作することになり、実機でしか出ない不具合の温床になる（CLAUDE.md「CSS が hidden を殺した」— jsdom は CSS のカスケードを評価しない）。

**muter が自分で面倒を見る**:

```
const restored = revealCard(card)     // 隠れていたら display を戻す。戻したら true
try   { ... メニュー操作 ... }
finally { if (restored) concealCard(card) }   // 元に戻す
```

これで **どちらが先に走っても同じ結果**になる。`finally` に置くので、途中で何が起きても隠し直される。

### AD-4 — `muteOnValid` は `storage.local`。`Settings`（sync）に入れない

`Settings` は `detectCandidates(index, settings, now)` の入力である。**判定に関係しない値を混ぜない**（設計上の約束 9 の精神 —「ライトモードとフルモードで判定ロジックを 2 本持たない」のと同じ理由で、判定の入力を汚さない）。

トークンと同じく `storage.local` に単独のキーで置く。**既定は `false`。**明示的にオンにしたときだけ Qiita 側を変更する。

**この既定値のおかげで、Phase 6 / 7 の既存テストは 1 つも書き換えずに通る。**

### AD-5 — `MuteOutcome` は `types/domain.ts` に置く。`dom/muter.ts` ではない

`popup-state.ts` がこの型を使う。`dom/muter.ts` に置くと **ポップアップが DOM 操作モジュールを import することになる**（ポップアップにトレンドページの DOM は無い）。

CLAUDE.md の教訓の一般形:

> 例外型の置き場所はテスト戦略に依存する。`RateLimitError` を投げる側のモジュールに置くと、そのモジュールを `vi.mock` するテストで `instanceof` が実行時に壊れる。

型は「使う側が全員たどり着ける場所」に置く。

### AD-6 — 画面に居ない著者はスキップする。ユーザーページを開きに行かない

`qiita.com/{handle}` にもミュートメニューはある（OQ-3 で確認済み）。**だが開きに行かない。**

拡張が自動でページ遷移を起こすと「表示中の DOM を読むだけならリクエストが 1 本も増えない」という前提が崩れる。**制約は迂回するより消す方が強い**（CLAUDE.md）。ここを消したままにしておけば、設計上の約束 1 の解釈が今後も一切不要になる。

取りこぼしは `not-on-page` として結果に出し、次にトレンドを開いたときに押し直してもらう。

---

## Files to Change

| ファイル | 操作 | 理由 |
|---|---|---|
| `src/dom/selectors.ts` | UPDATE | `cardMenuButton` / `menuItem` / `cardMenu` を `SELECTORS` へ、`MENU_TEXT` を新設 |
| `src/dom/trend-reader.ts` | UPDATE | `readTrendCards`（記事とカードの組）を切り出す |
| `src/dom/hider.ts` | UPDATE | 自前のカード走査を `readTrendCards` に置き換え（DRY）＋ `revealCard` / `concealCard` を export |
| **`src/dom/muter.ts`** | **CREATE** | メニュー操作と Snackbar 待ち。**DOM を書き換える 2 つ目のモジュール** |
| `src/types/domain.ts` | UPDATE | `MuteOutcome` / `MuteRecord` / `MuteLog`、`LocalState` に 2 キー |
| `src/types/messages.ts` | UPDATE | `MUTE_AUTHOR` リクエストと `MUTE_RESULT` レスポンス |
| `src/lib/storage.ts` | UPDATE | `getMuteOnValid` / `saveMuteOnValid` / `getMuteLog` / `recordMuteOutcome` |
| `src/content/content-script.ts` | UPDATE | `onMessage` リスナー ＋ 直列キュー |
| `src/ui/popup/popup-state.ts` | UPDATE | `requestMute` / `describeMuteOutcome` / `CandidateView.mute` |
| `src/ui/popup/popup-page.ts` | UPDATE | チェックボックスの配線 ＋ `handleVerdict` に 1 分岐 ＋ 結果行 |
| `src/ui/popup/index.html` | UPDATE | チェックボックスと解除案内 |
| `src/test/setup.ts` | UPDATE | `tabs.query` / `tabs.sendMessage` のモック |
| **`src/dom/muter.test.ts`** | **CREATE** | ブロック誤爆の番人を含む |
| `src/dom/hider.test.ts` / `selectors.test.ts` / `content-script.test.ts` / `popup-page.test.ts` / `popup-state.test.ts` / `storage.test.ts` | UPDATE | 追加分のテスト |

## NOT Building

- **一括ミュート（案 C）。** ユーザーが A を選んだ。ポップアップ下部の「妥当なものをまとめてミュート」ボタンは作らない
- **候補ごとの独立したミュートボタン（案 B）。**
- **ユーザーページを開いてのミュート。** AD-6
- **ミュートの解除。** `settings/mutes` でユーザーが行う。拡張は解除側の文言を知らないままにしておく（誤爆防止のため知らない方が安全）
- **ブロックの自動実行。** native `alert()` で自動化不可（設計上の約束 7 / PRD の Won't）
- **自動リトライ・リトライキュー。** 「妥当」を押し直すのがリトライ（AD-1）
- **`tabs` 権限の追加。** `host_permissions` で足りる
- **`scripting` 権限 / `chrome.scripting.executeScript`。** content script が既に注入されている
- **バッジへのミュート件数表示。** Phase 7 で「バッジは 429 > 候補件数 > 空の 3 つで埋まっている」と決定済み。`badge.ts` は変更しない
- **`alarms` の復活。** 設計上の約束 10

---

## Step-by-Step Tasks

### Task 1: `selectors.ts` にメニューのセレクタと文言を足す

- **ACTION**: `SELECTORS` に 3 件追加し、`MENU_TEXT` を新設する
- **IMPLEMENT**:

```ts
export const SELECTORS = {
  // ...既存...
  /**
   * カードの三点メニューを開くボタン。
   * aria-haspopup と aria-label はどちらも ARIA の契約で、CSS-in-JS の
   * ハッシュクラスと違ってリニューアルに耐える。aria-controls が
   * <ul role="menu"> の id を指す（開いたあとに読むこと）。
   */
  cardMenuButton: '[aria-haspopup="dialog"][aria-label="ユーザーを管理"]',
  /** メニューの項目。**どれを押すかはテキスト完全一致だけで決める** */
  menuItem: '[role="menuitem"]',
  /** 開いたメニュー本体。aria-controls の id と突き合わせて特定する */
  cardMenu: '[role="menu"]',
} as const;

/**
 * メニュー項目の文言。**完全一致でのみ使う。**
 *
 * ⚠️ ブロックがミュートの **直上** にある（OQ-9 実測）。順序やインデックスで
 * 選ぶと 1 つずれただけでブロックを踏む。ブロックは native alert() を起動して
 * content script から閉じられず、解除用の一覧 URL も無いので回収できない
 * （設計上の約束 7）。**block は「押してはいけないもの」としてだけ持ち、
 * テストが誤爆を検査するために使う。**
 *
 * 既にミュート済みのユーザーは文言が変わる（解除側になる）。完全一致なら
 * **解除の文言を知らないまま安全に何もしない。**知らない方が安全なので調べない。
 */
export const MENU_TEXT = {
  mute: '投稿ユーザーをミュート',
  block: '投稿ユーザーをブロック',
} as const;
```

- **MIRROR**: `SELECTORS` の既存エントリ（JSDoc で安定性の根拠を書く）／`SNACKBAR_TEXT`
- **IMPORTS**: なし
- **GOTCHA**: **`selectors.test.ts` が `Object.values(SELECTORS)` に `.` が 1 つでもあると落とす。**上の 3 つはドットを含まないので通る。`MENU_TEXT` は `SELECTORS` とは別オブジェクトなので検査対象外（`NOTICE_ID` と同じ扱い）
- **VALIDATE**: `npx vitest run src/dom/selectors.test.ts`

### Task 2: `selectors.test.ts` に「ブロックの文言を持っていること」の検査を足す

- **ACTION**: `MENU_TEXT` のテストを 2 件足す
- **IMPLEMENT**:

```ts
describe('MENU_TEXT', () => {
  it('ミュートとブロックが別々の文字列である', () => {
    // ⚠️ ブロックはミュートの直上にある。**取り違えると回収できない**
    expect(MENU_TEXT.mute).not.toBe(MENU_TEXT.block);
  });

  it('ミュートとブロックの文言が互いを部分文字列として含まない', () => {
    // 完全一致で選ぶ根拠。片方がもう片方に含まれると、実装を
    // includes に変えたときに気づけなくなる
    expect(MENU_TEXT.mute.includes(MENU_TEXT.block)).toBe(false);
    expect(MENU_TEXT.block.includes(MENU_TEXT.mute)).toBe(false);
  });
});
```

- **MIRROR**: `selectors.test.ts` の `describe('SELECTORS')`
- **VALIDATE**: 上と同じ

### Task 3: `trend-reader.ts` に `readTrendCards` を切り出す

- **ACTION**: 記事とカードの組を返す関数を新設して export する
- **IMPLEMENT**:

```ts
/** 記事 1 件と、それが載っているカード要素の組 */
export interface TrendCard {
  item: TrendItem;
  card: HTMLElement;
}

/**
 * 表示中のページから「記事 ＋ カード要素」の組を読む。
 *
 * **1 カードにつき 1 件しか返さない**（記事リンクが 2 本あるため、
 * カード要素そのものを Map のキーにして畳み込む）。
 *
 * 【なぜ hider と muter で共有するのか】
 * 「リンクを列挙 → findCard で祖先を辿る → 著者を引く」という同じ手順を
 * 2 箇所に書くと、片方だけ直して直したつもりになる。CLAUDE.md の
 * 「同じ形の窓が 3 つあり、1 つ直しても残りが同じことをしていた」がこれ。
 *
 * **隠れているカードも返す。**ミュートは Phase 7 が隠したあとに走りうる。
 */
export function readTrendCards(root: ParentNode = document): TrendCard[] {
  const byCard = new Map<HTMLElement, TrendCard>();
  for (const link of root.querySelectorAll<HTMLAnchorElement>(SELECTORS.trendItemLink)) {
    const card = findCard(link);
    if (!(card instanceof HTMLElement) || byCard.has(card)) continue;
    const [item] = readTrendItems(card);
    if (item === undefined) continue;
    byCard.set(card, { item, card });
  }
  return [...byCard.values()];
}
```

- **MIRROR**: `readTrendItems`（`Map` で畳み込む・失敗は `continue`）
- **IMPORTS**: 既存のものだけ（`SELECTORS` / `findCard` / `readTrendItems` は同ファイル内）
- **GOTCHA**: `findCard` は `Element | null` を返す。`instanceof HTMLElement` で絞ること（`hider.ts:74` と同じ）。**`readTrendItems(card)` にカードを渡す**（カード 1 枚に絞って著者を引く）
- **VALIDATE**: `npx vitest run src/dom/trend-reader.test.ts`

### Task 4: `hider.ts` を `readTrendCards` に載せ替え、表示の出し入れを export する

- **ACTION**: `hideJudgedAuthors` のループを差し替え、`revealCard` / `concealCard` を新設して export
- **IMPLEMENT**:

```ts
import { readTrendItems, readTrendCards } from './trend-reader';   // findCard は不要になる

export function hideJudgedAuthors(feedback: FeedbackLog, root: ParentNode = document): HideResult {
  const targets = new Set(
    readTrendItems(root)
      .filter((item) => feedback[item.authorHandle] === 'valid')
      .map((item) => item.authorHandle),
  );
  if (targets.size === 0) return { hidden: 0, authors: [] };

  const hiddenAuthors = new Set<AccountHandle>();
  let hidden = 0;

  for (const { item, card } of readTrendCards(root)) {
    if (!targets.has(item.authorHandle)) continue;
    if (isHidden(card)) continue;   // 既に隠れているものを二重に数えない
    concealCard(card);
    // 背景の目印は「表示する」で戻したときに残る。どのカードが該当かが
    // 分からないと、誤検知の確認ができない
    card.style.backgroundColor = HIGHLIGHT_BACKGROUND;
    card.dataset[HIGHLIGHT_MARKER] = 'true';
    hiddenAuthors.add(item.authorHandle);
    hidden += 1;
  }

  return { hidden, authors: [...hiddenAuthors].sort() };
}

/**
 * カードを 1 枚隠す。**インラインの display を使う**（hidden 属性だと
 * Qiita 側の CSS に負ける — Phase 6 で踏んだ）。
 */
export function concealCard(card: HTMLElement): void {
  card.style.display = 'none';
  card.dataset[HIDDEN_MARKER] = 'true';
}

/**
 * カードを 1 枚だけ表示に戻す。**隠れていたときだけ true を返す。**
 *
 * ミュートの操作中に一時的に戻すために要る（muter.ts の AD-3）。
 * 背景の目印には触らない — あれは「妥当と判断した」印であって、
 * 隠れているかどうかとは別の情報（HIGHLIGHT_MARKER の JSDoc 参照）。
 */
export function revealCard(card: HTMLElement): boolean {
  if (!isHidden(card)) return false;
  card.style.removeProperty('display');
  delete card.dataset[HIDDEN_MARKER];
  return true;
}
```

`unhideAll` の中身も `revealCard` を使う形に寄せる（**戻り値の意味は変えない** — 戻した件数）。

- **MIRROR**: 既存の `unhideAll` / `clearHighlights`
- **IMPORTS**: `readTrendCards` を追加、`findCard` の import を削除
- **GOTCHA**: **`SELECTORS` の import が未使用になるなら消す**（`no-unused-vars` で落ちる）。`hideJudgedAuthors` の**戻り値と副作用は 1 ミリも変えないこと** — Phase 7 は実機確認済みで、`hider.test.ts` が 100% カバーしている。テストを 1 つも書き換えずに通ることが正しさの証拠
- **VALIDATE**: `npx vitest run src/dom/hider.test.ts src/content/content-script.test.ts` — **既存テストを一切変更せずに全通しすること**

### Task 5: `types/domain.ts` に結果の型を足す

- **ACTION**: `MuteOutcome` / `MuteRecord` / `MuteLog` を定義し、`LocalState` に 2 キー追加
- **IMPLEMENT**:

```ts
/**
 * ミュートを試みた結果。**例外ではなく値で返す**（DOM 層は投げない・約束 3）。
 *
 * **`popup-state.ts` が使うのでここに置く。**`dom/muter.ts` に置くと
 * ポップアップが DOM 操作モジュールを import することになる（AD-5）。
 *
 * `menu-unavailable` は「メニューに『投稿ユーザーをミュート』が無かった」。
 * **既にミュート済みの場合もここに入る** — 項目がトグルで文言が変わるため、
 * 完全一致では見分けられない。**見分けようとしない**（解除の文言を実装に
 * 持ち込むと、それを押してしまう経路ができる）。UI の文言で両方を言う。
 */
export type MuteOutcome =
  /** Snackbar で完了を確認した */
  | 'muted'
  /** その著者のカードが表示中のページに無い（トレンドが入れ替わった等） */
  | 'not-on-page'
  /** 三点メニューか「投稿ユーザーをミュート」が見つからない。既にミュート済みを含む */
  | 'menu-unavailable'
  /** クリックしたが Snackbar が出なかった。成功しているかは不明 */
  | 'timeout'
  /** トレンドページを開いているタブが無い */
  | 'no-trend-tab'
  /** タブに届かなかった（content script が孤児になっている等） */
  | 'unreachable';

export interface MuteRecord {
  outcome: MuteOutcome;
  at: IsoDateTime;
}

/** 著者ハンドル -> 最後にミュートを試みた結果。UI に出すためだけに持つ */
export type MuteLog = Record<AccountHandle, MuteRecord>;
```

`LocalState` に追加:

```ts
  /** 「妥当」と同時にミュートするか。**既定は false**（AD-4） */
  muteOnValid?: boolean;
  /** ミュートを試みた結果。失敗の記録（PRD Phase 8 の Scope） */
  muteLog?: MuteLog;
```

- **MIRROR**: 同ファイルの `Verdict` / `FeedbackLog` / `AuthorVisits`
- **GOTCHA**: `LocalState` に足しても実行時の検証は増えない。読む側（`storage.ts`）で必ず検証すること
- **VALIDATE**: `npm run typecheck`

### Task 6: `types/messages.ts` にミュートのメッセージを足す

- **ACTION**: リクエストとレスポンスを 1 種ずつ追加
- **IMPLEMENT**:

```ts
import type { AccountHandle, MuteOutcome, TrendItem } from './domain';

/**
 * content script / UI -> service worker / content script
 *
 * MUTE_AUTHOR は **ポップアップから content script へ直接**送る
 * （chrome.tabs.sendMessage）。service worker は経由しない。
 *
 * **storage.onChanged で代用しない。**評価が既に valid なら値が変わらず
 * 通知が発火せず、押し直しでのやり直しができなくなる（AD-1）。
 * ミュートは状態の同期ではなく操作である。
 */
export type QtgRequest =
  | { type: 'PING' }
  | { type: 'TREND_ITEMS'; items: TrendItem[] }
  | { type: 'MUTE_AUTHOR'; handle: AccountHandle };

export type QtgResponse =
  | { type: 'PONG'; version: string }
  | { type: 'SCAN_ACCEPTED' }
  | { type: 'MUTE_RESULT'; handle: AccountHandle; outcome: MuteOutcome };
```

- **MIRROR**: 既存の 2 種
- **GOTCHA**: レスポンスに `handle` を載せる（**別コンテキストから来る値を型ガードで検証する**ため。`content-script.ts:25` の `isPongResponse` と同じ思想）
- **VALIDATE**: `npm run typecheck`

### Task 7: `storage.ts` に 4 つの入口を足す

- **ACTION**: `muteOnValid` の読み書きと `muteLog` の読み書きを追加
- **IMPLEMENT**:

```ts
/**
 * 「妥当」と同時にミュートするか。**既定は false。**
 *
 * 明示的にオンにしたときだけ Qiita 側を変更する。Settings（sync）に
 * 入れないのは、あれが detectCandidates の入力だから（AD-4）。
 */
export async function getMuteOnValid(): Promise<boolean> {
  const raw = await readRaw();
  return raw.muteOnValid === true;
}

export async function saveMuteOnValid(muteOnValid: boolean): Promise<void> {
  await chrome.storage.local.set({ muteOnValid });
}

/** 妥当な MuteOutcome だけを通す。storage が壊れていても全体を捨てない */
const MUTE_OUTCOMES = new Set<string>([
  'muted',
  'not-on-page',
  'menu-unavailable',
  'timeout',
  'no-trend-tab',
  'unreachable',
]);

export async function getMuteLog(): Promise<MuteLog> {
  const raw = await readRaw();
  const stored = raw.muteLog;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const log: MuteLog = {};
  for (const [handle, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Partial<Record<keyof MuteRecord, unknown>>;
    const at = asNonEmptyString(record.at);
    if (at === null || typeof record.outcome !== 'string') continue;
    if (!MUTE_OUTCOMES.has(record.outcome)) continue;
    log[handle] = { outcome: record.outcome as MuteOutcome, at };
  }
  return log;
}

/** 1 件記録し、**書いた後の全体を返す**（saveVerdict と同じ形） */
export async function recordMuteOutcome(
  handle: AccountHandle,
  outcome: MuteOutcome,
  now: Date,
): Promise<MuteLog> {
  const muteLog = { ...(await getMuteLog()), [handle]: { outcome, at: now.toISOString() } };
  await chrome.storage.local.set({ muteLog });
  return muteLog;
}
```

- **MIRROR**: `getFeedback` / `saveVerdict` / `getAuthorVisits`（1 件壊れても全体を捨てない・読んで足して書く・書いた後の全体を返す）
- **IMPORTS**: `MuteLog` / `MuteOutcome` / `MuteRecord` を `../types/domain` の type import に追加
- **GOTCHA**: `raw.muteOnValid === true` と書くこと。`Boolean(raw.muteOnValid)` だと `'false'` という文字列が true になる。**`now` を引数に取る**（テストが時刻を固定できるように。`author-visits.ts` と同じ）
- **VALIDATE**: `npx vitest run src/lib/storage.test.ts`

### Task 8: `src/dom/muter.ts` を作る ★中核

- **ACTION**: メニュー操作と Snackbar 待ちを実装する
- **IMPLEMENT**:

```ts
/**
 * トレンドカードから Qiita 公式のミュートを実行する。
 *
 * **DOM を書き換えるモジュールは hider.ts とこれの 2 つだけ。**
 *
 * 【ブロックを絶対に押さない】
 * メニューは「フォロー / **ブロック** / ミュート」の順で、**ブロックが
 * ミュートの直上にある**（OQ-9 実測）。ブロックは native alert() を起動して
 * content script から閉じられず、解除用の一覧 URL も存在しないので
 * 誤検知を回収できない（設計上の約束 7）。
 * **順序・インデックス・部分一致では選ばない。テキスト完全一致だけ。**
 *
 * 【既にミュート済みなら何もしない】
 * 項目はトグルなので、ミュート済みだと文言が解除側に変わる。完全一致なら
 * 一致せず何も押さない。**解除の文言は実装に持ち込まない** — 持ち込むと
 * それを押す経路ができる。知らない方が安全。
 *
 * 【隠れているカードでも動く】
 * Phase 7 が「妥当」でカードを display:none にする。ミュートと非表示は
 * 同時に走り、順序は保証されない。ここで一時的に表示へ戻し、finally で
 * 必ず戻す（AD-3）。jsdom は CSS のカスケードを評価しないので、
 * 「隠れていても click は飛ぶ」に賭けると実機でしか出ない不具合になる。
 *
 * 【失敗しても投げない】
 * 何が起きたかを MuteOutcome で返す。呼び出し側が UI に出す（約束 3）。
 */
import { SELECTORS, MENU_TEXT, SNACKBAR_TEXT, readSnackbarMessage } from './selectors';
import { readTrendCards } from './trend-reader';
import { revealCard, concealCard } from './hider';
import type { AccountHandle, MuteOutcome } from '../types/domain';

/**
 * 連続実行の間隔（ミリ秒）。**手動操作と同程度の負荷に留める**
 * （PRD の「スロットリングすれば手動と同負荷」）。
 */
export const MUTE_INTERVAL_MS = 1000;

/** Snackbar を待つ上限。出なければ timeout として返す */
export const SNACKBAR_TIMEOUT_MS = 5000;

/**
 * 著者のカードを 1 枚返す。**隠れているカードも対象。**
 * 同じ著者の記事が 2 本トレンドに出ていても、ミュートは 1 回で足りる。
 */
export function findAuthorCard(
  handle: AccountHandle,
  root: ParentNode = document,
): HTMLElement | null {
  return readTrendCards(root).find((entry) => entry.item.authorHandle === handle)?.card ?? null;
}

/**
 * 三点メニューを開き、開いたメニュー要素を返す。
 *
 * **aria-controls はクリックしたあとに読む。**React は開いたときに初めて
 * 属性を設定することがある。
 *
 * **`#id` のセレクタを組み立てない。**React の生成 ID は `:r1:` のように
 * コロンを含み、CSS セレクタとしては不正になる。`[role="menu"]` を列挙して
 * id を比較する（文字列のエスケープが要らず、壊れようが無い）。
 *
 * aria-controls が無ければ null。**カード内の [role="menu"] を代わりに
 * 探すような当て推量はしない** — 実測されているのは aria-controls だけ。
 */
function openMenu(card: HTMLElement, root: ParentNode): HTMLElement | null {
  const button = card.querySelector<HTMLElement>(SELECTORS.cardMenuButton);
  if (button === null) return null;
  button.click();
  const menuId = button.getAttribute('aria-controls');
  if (menuId === null || menuId === '') return null;
  for (const menu of root.querySelectorAll<HTMLElement>(SELECTORS.cardMenu)) {
    if (menu.id === menuId) return menu;
  }
  return null;
}

/**
 * 「投稿ユーザーをミュート」に **完全一致** する項目だけを返す。
 * 一致しなければ null。**ここが誤爆を止める唯一の砦。**
 */
export function findMuteItem(menu: ParentNode): HTMLElement | null {
  for (const item of menu.querySelectorAll<HTMLElement>(SELECTORS.menuItem)) {
    if (item.textContent?.trim() === MENU_TEXT.mute) return item;
  }
  return null;
}

/**
 * Snackbar に指定のメッセージが出るまで待つ。出れば true、時間切れなら false。
 *
 * **固定 sleep を使わない**（PRD の設計判断）。1 件ごとに成功を確認してから
 * 次へ進めるので、一括実行が堅牢になる。
 *
 * 観測対象は常に document — Snackbar は body 直下にマウントされ、
 * カードの外にある。読む側は root を尊重する（テストのため）。
 */
export function waitForSnackbar(
  expected: string,
  root: ParentNode = document,
  timeoutMs: number = SNACKBAR_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    // クリックが同期的に Snackbar を出す実装もありうる。先に見る
    if (readSnackbarMessage(root) === expected) {
      resolve(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (found: boolean): void => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      resolve(found);
    };
    const observer = new MutationObserver(() => {
      if (readSnackbarMessage(root) === expected) finish(true);
    });
    timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

/**
 * 著者を 1 人ミュートする。**例外を投げない。**
 *
 * 隠れているカードは一時的に戻し、finally で必ず隠し直す。どちらが先に
 * 走っても同じ結果になる（AD-3）。
 */
export async function muteAuthor(
  handle: AccountHandle,
  root: ParentNode = document,
  timeoutMs: number = SNACKBAR_TIMEOUT_MS,
): Promise<MuteOutcome> {
  const card = findAuthorCard(handle, root);
  if (card === null) return 'not-on-page';

  const restored = revealCard(card);
  try {
    const menu = openMenu(card, root);
    if (menu === null) return 'menu-unavailable';
    const item = findMuteItem(menu);
    if (item === null) return 'menu-unavailable';
    item.click();
    const done = await waitForSnackbar(SNACKBAR_TEXT.muteCompleted, root, timeoutMs);
    return done ? 'muted' : 'timeout';
  } finally {
    if (restored) concealCard(card);
  }
}
```

- **MIRROR**: `hider.ts`（`root: ParentNode = document` を取る・`null` で諦める・JSDoc に理由を書く）／`selectors.ts` の `readSnackbarMessage`
- **IMPORTS**: 上記のとおり
- **GOTCHA**:
  - **`SNACKBAR_TEXT` と `readSnackbarMessage` は既に `selectors.ts` にある。作り直さない**（Phase 2 で実装済み・テスト済み）
  - `observer` を `finish` の中で参照するため、`const observer` は `finish` の**後**に宣言してよい（`const` は TDZ だが、`finish` が呼ばれるのは observer 生成後）。ESLint の `no-use-before-define` が変数に対して有効なら順序を入れ替えること
  - `observer.observe(document.documentElement, ...)` — **`document.body` ではない。**jsdom でも実機でも `documentElement` は必ず存在する
  - **`hider.ts` を import して循環参照にならないことを確認する。**`hider` → `trend-reader` / `selectors`、`muter` → `hider` / `trend-reader` / `selectors`。**一方向なので循環しない**
  - `timeoutMs` を `muteAuthor` の引数に出しておく（テストが実時間で待たずに済む）
- **VALIDATE**: Task 9 のテストで検証

### Task 9: `src/dom/muter.test.ts` を書く ★誤爆の番人

- **ACTION**: 新規テストファイル
- **IMPLEMENT**: フィクスチャは `hider.test.ts` の `card(n)` を拡張してメニュー付きにする。**実アカウント名は使わない。**

```ts
/**
 * メニュー付きのカード。実測どおり **記事リンクを 2 本** 持たせ、
 * メニュー項目は既定で「フォロー / ブロック / ミュート」の順にする
 * （**ブロックがミュートの直上**という実測を再現する）。
 * menuId に既定でコロンを含めるのは、React の生成 ID を模すため。
 */
function cardWithMenu(
  n: number,
  items: string[] = ['投稿ユーザーをフォロー', MENU_TEXT.block, MENU_TEXT.mute],
  menuId = `:r${String(n)}:`,
): string
```

**必須のテスト（漏らさないこと）**:

| # | テスト名 | 何を守るか | 変異での確認 |
|---|---|---|---|
| 1 | `「投稿ユーザーをミュート」だけをクリックする` | 正常系 | — |
| 2 | **`ブロックの項目を絶対にクリックしない`** | 誤爆 | 各項目に spy を張り、ブロックの spy が 0 回であること |
| 3 | **`項目の順序が違ってもミュートを選ぶ`**（ミュートを先頭、ブロックを末尾に置く） | **インデックス選択を殺す** | 実装を `items[2]` に変えると落ちる |
| 4 | **`「投稿ユーザーのミュートを解除」しか無ければ何もクリックしない`** | **部分一致を殺す**＋既にミュート済み | 実装を `includes('ミュート')` に変えると落ちる。戻り値は `menu-unavailable` |
| 5 | `カードが無ければ not-on-page を返す` | AD-6 | — |
| 6 | `三点メニューのボタンが無ければ menu-unavailable を返す` | フェイルセーフ | — |
| 7 | `aria-controls が無ければ menu-unavailable を返す` | 当て推量をしない | カード内に `[role="menu"]` を置いても掴まないこと |
| 8 | `aria-controls の id にコロンが含まれていても辿れる`（`:r1:`） | React の生成 ID | 実装を `` `#${id}` `` に変えると `SyntaxError` で落ちる |
| 9 | **`隠れているカードでも、メニューを開く瞬間は表示に戻っている`** | **AD-3** | メニューボタンの click リスナーで `card.style.display` を記録し、`''` であること |
| 10 | **`ミュートのあとカードは隠れた状態に戻る`** | AD-3 | `card.style.display === 'none'` かつ `data-qtg-hidden` が残る |
| 11 | `隠れていなかったカードは、そのまま表示のままにする` | AD-3 の逆 | `revealCard` が false を返す経路 |
| 12 | `Snackbar が出れば muted を返す` | 完了検知 | クリック時に Snackbar を挿入するリスナーで再現 |
| 13 | `Snackbar が出なければ timeout を返す` | 完了検知 | `timeoutMs` に 10 を渡して実時間で待つ |
| 14 | `同じ著者の記事が 2 本あっても 1 枚しか操作しない` | 重複 | メニューボタンの click 合計が 1 |
| 15 | `壊れた DOM でも例外を投げない` | 約束 3 | `await expect(...).resolves.toBe('menu-unavailable')` |

**Test 9 の書き方**（これが弱いと AD-3 が守られない）:

```ts
it('隠れているカードでも、メニューを開く瞬間は表示に戻っている', async () => {
  // Arrange — Phase 7 が隠したあとの状態を作る
  document.body.innerHTML = cardWithMenu(1);
  const card = document.querySelector<HTMLElement>('.card');
  if (!card) throw new Error('card not found');
  concealCard(card);
  const displayAtClick: string[] = [];
  card.querySelector(SELECTORS.cardMenuButton)?.addEventListener('click', () => {
    displayAtClick.push(card.style.display);
  });
  // Act
  await muteAuthor('example-author-1', document, 10);
  // Assert — display:none のまま操作していたら '' にならない
  expect(displayAtClick).toEqual(['']);
});
```

- **MIRROR**: `hider.test.ts`（AAA コメント・日本語のテスト名・合成フィクスチャ）
- **GOTCHA**:
  - **`vi.useFakeTimers()` を使わない。**`waitForSnackbar` は `MutationObserver`（マイクロタスク）と `setTimeout` の両方を使う。timeout 系は `timeoutMs` に 10ms を渡して実時間で待つ方が単純で確実
  - jsdom の `MutationObserver` はマイクロタスクで発火する。Snackbar は**クリックのリスナーの中で挿入**すれば `muteAuthor` の `await` が拾える
  - **テストを書いたら、直した箇所を戻して落ちることを必ず確認する**（CLAUDE.md の教訓）。特に #2 / #3 / #4 / #9 は変異を入れて確認すること
- **VALIDATE**: `npx vitest run src/dom/muter.test.ts`

### Task 10: `content-script.ts` にメッセージ受信と直列キューを足す

- **ACTION**: `chrome.runtime.onMessage` リスナーとキューを追加し、トップレベルで登録する
- **IMPLEMENT**:

```ts
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ミュートを直列につなぐ。**デバウンスでは足りない。**
 *
 * タイマーは発火した瞬間に手を離すので、実行中の処理は次を止めない
 * （CLAUDE.md「デバウンスは頻度を下げるが同時実行は止めない」）。
 * ミュートは Qiita の DOM を実際に操作するので、2 件が重なると
 * 片方のメニューが開いたまま別のカードを触ることになる。
 *
 * 間隔を空けるのは、手動操作と同程度の負荷に留めるため（PRD）。
 */
let muteQueue: Promise<unknown> = Promise.resolve();

function enqueueMute(handle: AccountHandle): Promise<MuteOutcome> {
  const result = muteQueue.then(() => muteAuthor(handle));
  // 失敗しても列は止めない。sleep は成否どちらでも挟む
  muteQueue = result.then(
    () => sleep(MUTE_INTERVAL_MS),
    () => sleep(MUTE_INTERVAL_MS),
  );
  return result;
}

/** ポップアップから来る値なので、型アサーションではなく型ガードで受ける */
function isMuteRequest(value: unknown): value is Extract<QtgRequest, { type: 'MUTE_AUTHOR' }> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<{ type: unknown; handle: unknown }>;
  return candidate.type === 'MUTE_AUTHOR' && typeof candidate.handle === 'string';
}

/**
 * ミュートの依頼を受ける。**storage.onChanged ではなくメッセージで受ける理由**は
 * AD-1 のとおり — 評価が既に valid なら値が変わらず通知が来ないので、
 * 押し直しでのやり直しができなくなる。ミュートは状態ではなく操作である。
 *
 * **トレンドページ以外では応じない。**プロフィールページにも記事一覧と
 * <time> が揃っているので、素通しにするとトレンドでないカードを操作しうる
 * （「エラーが出ないことと、やるべきでないことをやらないことは別物」）。
 */
function listenForMute(): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isMuteRequest(message)) return undefined; // 扱わない。チャネルを開かない
    const { handle } = message;
    const respond = (outcome: MuteOutcome): void => {
      const response: QtgResponse = { type: 'MUTE_RESULT', handle, outcome };
      sendResponse(response);
    };
    if (!isTrendPage(location.pathname)) {
      respond('not-on-page');
      return undefined;
    }
    enqueueMute(handle)
      .then((outcome) => {
        if (outcome === 'muted') logger.info('muted:', handle);
        else logger.debug('mute skipped:', handle, outcome);
        respond(outcome);
      })
      .catch((error: unknown) => {
        // ここに来るのは想定外だが、ポップアップを待たせ続けない
        logger.debug('mute failed:', handle, error);
        respond('menu-unavailable');
      });
    return true; // 非同期で応答する
  });
}
```

トップレベルに `listenForMute();` を追加（`watchFeedback()` の隣）。

- **MIRROR**: `isPongResponse`（型ガード）／`applyChain`（popup-page.ts の直列化）／`watchFeedback`（リスナーを関数に包む）
- **IMPORTS**: `muteAuthor` / `MUTE_INTERVAL_MS` を `../dom/muter` から、`AccountHandle` / `MuteOutcome` を `../types/domain` から、`QtgResponse` は既存の type import に追加
- **GOTCHA**:
  - **`return true` は同期的に返すこと。**扱わないメッセージで `true` を返すとチャネルが開いたままになり、他のリスナー（service worker 側）の応答が捨てられる
  - **`return undefined` を明示する。**ESLint の `consistent-return` が混在を嫌う
  - **`chrome` はモジュールのトップレベルではまだ未定義**（`setup.ts` が各テスト前に用意する）。必ず関数の中で参照する
  - `sendResponse` の呼び出しが 2 回起きないこと（`respond` を 1 経路につき 1 回だけ）
  - **JSDoc と関数のあいだに新しい宣言を挿入しないこと。**この事故を 4 回やっている（CLAUDE.md）。編集後に `git diff` を目で追う
- **VALIDATE**: Task 11 のテスト

### Task 11: `content-script.test.ts` にミュートのテストを足す

- **ACTION**: 新しい `describe` を 1 つ追加。**既存の 13 件は 1 つも書き換えない**
- **IMPLEMENT**:

| # | テスト名 | 何を守るか |
|---|---|---|
| 1 | `MUTE_AUTHOR を受けるとメニューを操作する` | 正常系 |
| 2 | **`トレンド以外のページでは操作せず not-on-page を返す`** | 「やるべきでないことをやらない」 |
| 3 | `関係のないメッセージには応答せず、リスナーが true を返さない` | チャネルを塞がない |
| 4 | **`2 件続けて依頼しても重ならない`** | 直列化。1 件目の Snackbar 待ちの最中に 2 件目のメニューボタンが押されていないこと |
| 5 | `Snackbar が出れば MUTE_RESULT に muted を載せて返す` | 応答の形 |

**Test 4 の書き方**: 2 つのカードのメニューボタンに click リスナーを張り、押された順序を配列に記録する。1 件目の Snackbar を挿入する前に 2 件目が押されていないことを確認する。

**ヘルパー**（`storageListener()` と同じ形で書く）:

```ts
/** onMessage に登録されたリスナーを取り出す */
function messageListener() {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]?.[0];
  if (!listener) throw new Error('message listener not registered');
  return listener;
}
```

- **MIRROR**: `content-script.test.ts` の `storageListener()`
- **GOTCHA**: 実時間で 1 秒待たないよう、**時間そのものを検査しない**（順序だけを検査する）。`MUTE_INTERVAL_MS` は import した定数を参照する
- **VALIDATE**: `npx vitest run src/content/content-script.test.ts`

### Task 12: ポップアップ側（`setup.ts` / `index.html` / `popup-state.ts` / `popup-page.ts`）

- **ACTION**: chrome モックの拡張、チェックボックスの追加、タブ特定とメッセージ送信、結果の表示
- **IMPLEMENT**:

**(a) `src/test/setup.ts`** — `tabs` に 2 つ追加:

```ts
    // タブを作るだけなら tabs 権限は要らない（読み取りには要る）。
    // query の url フィルタと sendMessage は host_permissions で足りる
    tabs: {
      create: vi.fn(() => Promise.resolve({ id: 1 })),
      query: vi.fn(() => Promise.resolve([])),
      sendMessage: vi.fn(() => Promise.resolve()),
    },
```

**既定を `[]`（トレンドタブ無し）にする。**`muteOnValid` の既定が false なので、既存の popup テストはこれで一切変更なく通る。

**(b) `src/ui/popup/index.html`** — `<details id="conditions">` と `<ul id="candidates">` のあいだに:

```html
    <p class="mute-toggle">
      <label for="mute-on-valid">
        <input type="checkbox" id="mute-on-valid" />
        「妥当」と同時に Qiita 側でもミュートする
      </label>
    </p>
    <p class="footnote" id="mute-note">
      ミュートは
      <a href="https://qiita.com/settings/mutes" target="_blank" rel="noreferrer">設定 &gt; ミュート</a>
      から一覧・解除ができます。
    </p>
```

CSS に `.mute-toggle { margin: 0 0 4px; font-size: 0.9rem; }` と `.mute-status { font-size: 0.85rem; }` を追加。

> **`body { min-height: 569px }` の計算は触らない。**あれは「中身が 600px を**超えなかった**ときに窓幅がずれる」ことへの対策で、要素が増えて高くなるぶんには目的を果たしている（`index.html:7-26` のコメント参照）。

**(c) `popup-state.ts`** に追加:

```ts
/**
 * ミュートを依頼し、結果を記録して **更新後の全体を返す**（saveVerdict と同じ形）。
 *
 * **トレンドページを開いているタブ 1 枚にだけ送る。**2 枚に送ると、片方が
 * ミュートした直後にもう片方が古い DOM で同じ項目を押し、**トグルなので
 * 解除される**（AD-2）。
 *
 * chrome.tabs.query の url フィルタは tabs 権限を必要としない。
 * host_permissions（https://qiita.com/*）が一致していれば効く。
 */
export async function requestMute(handle: AccountHandle, now: Date): Promise<MuteLog> {
  return storage.recordMuteOutcome(handle, await sendMuteRequest(handle), now);
}

async function sendMuteRequest(handle: AccountHandle): Promise<MuteOutcome> {
  const tabId = await findTrendTabId();
  if (tabId === null) return 'no-trend-tab';
  try {
    const request: QtgRequest = { type: 'MUTE_AUTHOR', handle };
    const response: unknown = await chrome.tabs.sendMessage(tabId, request);
    return isMuteResult(response, handle) ? response.outcome : 'unreachable';
  } catch {
    // content script が孤児になっている（拡張をリロードした等）。想定内
    return 'unreachable';
  }
}

/**
 * トレンドページのタブを 1 枚選ぶ。**アクティブなタブを優先する** —
 * ユーザーが見ている画面で操作が起きる方が、何が起きたか分かる。
 * URL の解析は isTrendPage に任せ、パスの判定を 2 箇所に書かない。
 */
async function findTrendTabId(): Promise<number | null> { /* ... */ }

/** 別コンテキストから来る値。型ガードで受ける（isPongResponse と同じ思想） */
function isMuteResult(
  value: unknown,
  handle: AccountHandle,
): value is Extract<QtgResponse, { type: 'MUTE_RESULT' }> { /* ... */ }

/**
 * ミュートの結果の文言。**断定しない**（設計上の約束 6）。
 *
 * menu-unavailable は「既にミュート済み」と「Qiita の画面が変わった」の
 * 両方を含む。**見分けられないことを隠さずに書く** — 見分けようとすると
 * 解除の文言を実装に持ち込むことになり、それを押す経路ができる。
 */
export function describeMuteOutcome(outcome: MuteOutcome): string {
  switch (outcome) {
    case 'muted':
      return 'Qiita 側でミュートしました。';
    case 'not-on-page':
      return 'いま開いているトレンドページにこの著者の記事が無いため、ミュートできませんでした。次に出てきたときに押し直してください。';
    case 'no-trend-tab':
      return 'トレンドページを開いてから押してください。';
    case 'menu-unavailable':
      return 'ミュートのメニューが見つかりませんでした。既にミュート済みか、Qiita の画面構造が変わった可能性があります。';
    case 'timeout':
      return '完了の通知を確認できませんでした。設定 > ミュート で結果を確認してください。';
    case 'unreachable':
      return 'トレンドページに届きませんでした。ページを再読み込みしてから押し直してください。';
  }
}
```

`CandidateView` に `mute: MuteRecord | null` を追加し、`toViews(candidates, feedback, muteLog)` の第 3 引数から埋める。`loadPopupState` の `Promise.all` に `storage.getMuteOnValid()` と `storage.getMuteLog()` を足し、`PopupState` に `muteOnValid: boolean` を追加。

**(d) `popup-page.ts`**:

```ts
let currentMuteOnValid = false;
let currentMuteLog: MuteLog = {};

async function handleVerdict(handle: string, verdict: Verdict): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    currentPrecision = await recordVerdict(handle, verdict);
    // 「妥当」かつ設定がオンのときだけ Qiita 側を変更する。
    // **storage の変更を待つのではなくここから送る** — 既に valid のものを
    // 押し直したときも実行できる（AD-1）。これがリトライ手段でもある
    if (verdict === 'valid' && currentMuteOnValid) {
      showMutePending(handle); // 数秒かかる。押した直後に「ミュートしています…」を出す
      currentMuteLog = await requestMute(handle, new Date());
    }
    currentViews = currentViews.map((view) =>
      view.candidate.authorHandle === handle
        ? { ...view, verdict, mute: currentMuteLog[handle] ?? null }
        : view,
    );
    renderCandidates(currentViews);
    renderSummary(currentViews, currentPrecision);
  } finally {
    busy = false;
  }
}
```

チェックボックスの配線（`attachListeners` 内）:

```ts
  find<HTMLInputElement>(SELECTORS.muteOnValid)?.addEventListener('change', (event) => {
    const checked = event.target instanceof HTMLInputElement && event.target.checked;
    currentMuteOnValid = checked;
    saveMuteOnValid(checked).catch((error: unknown) => {
      logger.error('failed to save mute setting:', error);
    });
  });
```

`candidateItem` に結果行を追加（`coAuthorLine` と同じく **無ければ要素を作らない**）:

```ts
function muteStatusLine(view: CandidateView): HTMLParagraphElement[] {
  return view.mute === null
    ? []
    : [paragraph('mute-status', describeMuteOutcome(view.mute.outcome))];
}
```

`#mute-note` のリンクも背景タブで開く。**`#candidates` の委譲とは別要素なので、リンクを開く処理を小さな関数に括り出して両方から呼ぶ**（`openInBackground` の呼び出しを重複させない）。

- **MIRROR**: `handleVerdict` の `busy` フラグ／`coAuthorLine`（配列で返して展開）／`openInBackground`／`watchRateLimit`
- **IMPORTS**: `requestMute` / `describeMuteOutcome` を `./popup-state`、`saveMuteOnValid` を `../../lib/storage`、`MuteLog` を `../../types/domain`
- **GOTCHA**:
  - **`busy` は `requestMute` の完了まで保持される。**ミュートは数秒かかりうるので、その間ボタンが効かない。これは**意図どおり**（連打で二重に走らせない）。ただしユーザーには何も起きていないように見えるので、**押した直後に「ミュートしています…」を出してから待つこと**（`showMutePending`）
  - `describeMuteOutcome` の `switch` に `default` を書かない。`MuteOutcome` に値を足したとき TypeScript が漏れを教えてくれる
  - **`chrome.tabs.sendMessage` の型**: `@types/chrome` はオーバーロードを複数持つ。`content-script.test.ts:56-58` と同じ罠が出たら、**モック設定の 1 行に `as never` ＋ 理由コメント**を添える（**`as unknown as X` は eslint の `--fix` がアサーションごと消して元に戻す**）
- **VALIDATE**: `npx vitest run src/ui/popup/`

**ポップアップ側の必須テスト**:

| # | テスト名 | 何を守るか |
|---|---|---|
| 1 | **`同じ著者に「妥当」を 2 回押すと、2 回ミュートを依頼する`** | **★AD-1 の番人。**`storage.onChanged` 起動に変えると 2 回目が飛ばず落ちる |
| 2 | `チェックがオフなら依頼しない` | 既定オフ |
| 3 | `「誤り」では依頼しない` | 誤爆 |
| 4 | `トレンドタブが無ければ no-trend-tab を記録し、sendMessage を呼ばない` | AD-6 |
| 5 | **`トレンドページのタブにだけ送る`**（`/trend` と `/items/xxx` の 2 タブを用意し、trend の tabId にだけ送ること） | AD-2 |
| 6 | `sendMessage が reject しても落ちず unreachable を記録する` | フェイルセーフ |
| 7 | `結果の文言が候補の行に出る` | UI |
| 8 | `未実行の候補には結果行を出さない` | `coAuthorLine` と同じ性質 |
| 9 | `チェックを入れると storage に保存され、開き直しても残る` | 設定 |
| 10 | `describeMuteOutcome が 6 つの結果すべてに文言を返す` | 網羅（`popup-state.test.ts`） |

### Task 13: ドキュメントを更新する

- **ACTION**: PRD と CLAUDE.md を書き換える
- **IMPLEMENT**:
  - PRD の Phase 表: Phase 8 を `pending` → `in-progress`、PRP Plan 列に `[plan](../plans/mute-on-valid.plan.md)`
  - PRD の Phase 8 詳細:
    - **Success signal を A に合わせて書き換える**（現在は案 C の記述）: 「候補を『妥当』と評価すると Qiita 側でもミュートされ、`https://qiita.com/settings/mutes` に反映されている」
    - 「未確定」の段落を「**決定（2026-08-24）: 案 A。既定はオフのチェックボックス。案 C（一覧から一括）は作らない**」に置き換え
    - **スコープ外に「一括実行」「ユーザーページを開いてのミュート」を明記**
  - PRD の Risks 表: 「ミュートを起動するメニューの DOM が未取得」の行を**解決済みとして落とす**（OQ-9 は 93 行目で解決済み）
  - CLAUDE.md: Phase 表の 8 を in-progress に、現在地の行を更新
- **GOTCHA**: **長い文字列は必ずファイルに書いて経由させる。**バッククォートを含む文字列を `node -e` に直接渡すとシェルに食われて識別子が丸ごと消える（CLAUDE.md に 2 回記録済み、うち 1 回は**記録した 30 分後の再発**）。置換用の文字列は scratchpad のファイルに書いてから読み込むこと
- **VALIDATE**: `git diff --stat` で意図した行だけが変わっていること

---

## Testing Strategy

### Unit Tests（新規の主なもの）

| テスト | 入力 | 期待 | Edge? |
|---|---|---|---|
| `muteAuthor` 正常系 | メニュー付きカード ＋ クリック時に Snackbar | `'muted'`、ミュート項目だけ click | |
| **ブロック誤爆** | フォロー/ブロック/ミュート | ブロックの click 回数が **0** | ✅ |
| **順序違い** | ミュート/フォロー/ブロック | ミュートを click | ✅ |
| **解除文言のみ** | 「投稿ユーザーのミュートを解除」 | **何も click せず** `'menu-unavailable'` | ✅ |
| React 生成 ID | `aria-controls=":r1:"` | メニューを辿れる | ✅ |
| 隠れたカード | `display:none` ＋ `data-qtg-hidden` | click 時の display が `''`、終了後 `'none'` | ✅ |
| Snackbar 無し | `timeoutMs: 10` | `'timeout'` | ✅ |
| カード無し | 空の body | `'not-on-page'` | ✅ |
| 同一著者 2 記事 | カード 2 枚 | メニューボタンの click 合計 1 | ✅ |
| **押し直し** | 同じ handle に valid を 2 回 | `sendMessage` が 2 回 | ✅ |
| タブ選別 | `/trend` と `/items/x` の 2 タブ | trend の tabId にだけ送る | ✅ |
| タブ 0 枚 | `query` が `[]` | `'no-trend-tab'`、`sendMessage` 未呼出 | ✅ |
| `sendMessage` reject | `mockRejectedValue` | `'unreachable'`、例外を漏らさない | ✅ |
| storage 破損 | `muteLog` に不正な outcome | その 1 件だけ落とし、他は残す | ✅ |
| 直列化 | 2 件連続依頼 | 1 件目の完了前に 2 件目が押されない | ✅ |

### Edge Cases Checklist

- [x] 空の入力（カード 0 枚・メニュー 0 件・`muteLog` が空）
- [x] 同一著者の記事が 2 本トレンドにある（1 回だけミュート）
- [x] 不正な型（`muteLog` に知らない outcome、`muteOnValid` に文字列）
- [x] 同時実行（2 件連続の依頼・タブ 2 枚）
- [x] 通信の失敗（`sendMessage` の reject ＝ content script が孤児）
- [x] 権限の不足（`tabs.query` が空を返す ＝ トレンドタブなし）
- [x] **既にミュート済み**（メニューの文言が解除側 → 何もしない）

---

## Validation Commands

### 静的解析

```bash
npm run typecheck
```

EXPECT: 型エラーゼロ

### ユニットテスト（影響範囲）

```bash
npx vitest run src/dom src/content src/ui/popup src/lib/storage.test.ts
```

EXPECT: 全通過。**既存の hider / content-script / popup テストを 1 つも書き換えずに通ること**

### 全体

```bash
npm run test
```

EXPECT: 445 件 ＋ 追加分がすべて通過。カバレッジは Statements 95% 以上を維持

### Lint と整形

```bash
npm run lint && npm run format
```

EXPECT: エラーゼロ。**`format` を忘れないこと** — どのゲートにも入っておらず、Phase 4b 以来 10 ファイルが静かにずれていた（CLAUDE.md）

### ビルドと配線の検証

```bash
npm run build && cat dist/service-worker-loader.js && grep -o 'getURL("[^"]*")' dist/assets/*loader*.js
```

EXPECT: service worker ローダーと content script ローダーが**別々の正しいチャンク**を指すこと。ビルド成功は「正しく動く」を意味しない

### 想定内の失敗がエラー欄に載っていないか

```bash
grep -rn "logger.warn\|logger.error" src/dom/muter.ts src/ui/popup/popup-state.ts
```

EXPECT: 0 件

### 実機チェックリスト

> **⚠️ 「実機確認は試した経路しか保証しない」**（CLAUDE.md）。**全部やること。**とくに ✅ を飛ばさない。

- [ ] チェックがオフのまま「妥当」を押す → **カードが隠れるだけで、`settings/mutes` は増えていない**
- [ ] チェックを入れる → ポップアップを閉じて開き直す → **チェックが残っている**
- [ ] チェックを入れて「妥当」を押す → 結果行に「Qiita 側でミュートしました。」→ `settings/mutes` に**その 1 人だけ**増えている
- [ ] ✅ **同じ候補の「妥当」をもう一度押す** → 結果行が「メニューが見つかりませんでした（既にミュート済み…）」に変わる → **`settings/mutes` から消えていないこと**（＝ 解除されていない）
- [ ] ✅ **`settings/mutes` を開き、フォロー / ブロック された人が増えていないこと**
- [ ] ✅ **既に「妥当」を押してある 2 件で、チェックを入れてから押し直す** → ミュートが実行される（AD-1 の実証）
- [ ] ✅ トレンドタブを全部閉じてから「妥当」を押す → 「トレンドページを開いてから押してください。」
- [ ] ✅ 記事ページのタブだけ開いて「妥当」を押す → 同上（記事ページで DOM 操作が起きていないこと）
- [ ] ✅ トレンドタブを 2 枚開いて「妥当」を押す → **ミュートは 1 回だけ**（`settings/mutes` の件数で確認）
- [ ] ✅ **「表示する」でカードを戻した状態から「妥当」を押す** → ミュートが動き、カードの状態が壊れない
- [ ] ✅ 候補を 2 件続けて「妥当」する → **1 件ずつ順に**メニューが開く（重ならない）
- [ ] ✅ **`chrome://extensions` のエラー欄に 1 行も増えていないこと**
- [ ] 「誤り」を押す → ミュートは起きない
- [ ] 拡張をリロードしてから、開きっぱなしのトレンドタブで「妥当」を押す → 「トレンドページに届きませんでした。」（クラッシュしない）
- [ ] ミュートした著者の記事がトレンドから消える（次回リロード時）

---

## Acceptance Criteria

- [ ] Task 1〜13 完了
- [ ] `npm run typecheck` / `npm run lint` / `npm run format` / `npm run test` がすべて通る
- [ ] **既存の 445 件を 1 つも書き換えずに通る**
- [ ] `src/dom/muter.ts` のカバレッジが Statements 100%
- [ ] **`logger.warn` / `logger.error` を 1 つも増やしていない**（想定内の失敗は `debug`）
- [ ] `SELECTORS` にハッシュクラス名を入れていない（`selectors.test.ts` が検査）
- [ ] `permissions` に `tabs` / `scripting` を追加していない
- [ ] 実機チェックリストの ✅ 印を**すべて**実施した
- [ ] **変異テスト**: Task 9 の #2 / #3 / #4 / #9 と Task 12 の #1 / #5 について、実装を壊して**落ちることを確認した**

## Completion Checklist

- [ ] `hider.ts` と同じフェイルセーフの書き方（`null` / 値で返す・投げない）
- [ ] `storage.ts` と同じ検証の粒度（1 件壊れても全体を捨てない）
- [ ] `popup-state.ts` が `document` を参照していない
- [ ] テストが AAA コメントと日本語のテスト名を持つ
- [ ] **フィクスチャに実アカウント名・実 item_id が無い**（記事化の絶対制約）
- [ ] マジックナンバーが名前付き定数（`MUTE_INTERVAL_MS` / `SNACKBAR_TIMEOUT_MS`）
- [ ] PRD と CLAUDE.md を更新した
- [ ] **`git diff` を自分で目で追った** — JSDoc と関数のあいだに新しい宣言を挿入する事故を**4 回**やっている（CLAUDE.md）
- [ ] スコープを広げていない（案 B / C を作っていない）

---

## Risks

| リスク | 可能性 | 影響 | 緩和 |
|---|---|---|---|
| **ブロックを誤爆する** | **L** | **極大**（native alert で閉じられず、解除一覧も無い） | テキスト完全一致のみ。順序違いと解除文言の 2 つの変異テストで固定。**メニュー項目のインデックスをコードのどこにも書かない** |
| **既にミュート済みの相手を解除してしまう** | L | 大 | 完全一致なので解除側の文言に一致しない。**解除の文言を実装に持ち込まない**。AD-2 で 2 タブ同時実行も潰す |
| Phase 7 の非表示と競合してメニューが開かない | **M** | 中 | AD-3。`revealCard` / `finally` で `concealCard`。jsdom で検査（click 時の `display` を記録） |
| `aria-controls` が開く前に設定されていない | M | 中 | **クリックしたあとに読む**。無ければ `menu-unavailable` で諦める（当て推量の代替探索をしない） |
| React の生成 ID がコロンを含み `#id` セレクタが壊れる | M | 中 | `[role="menu"]` を列挙して `id` を比較。**セレクタ文字列を組み立てない**。`:r1:` のテストで固定 |
| メニューの文言が Qiita 側で変わる | M | 中 | 一致しなければ何もしない（フェイルセーフ）。UI が「Qiita の画面構造が変わった可能性があります」と伝える |
| Snackbar が React のポータルで `document.body` の外に出る | L | 小 | `document.documentElement` を観測する。それでも出なければ `timeout`（成功しているかは `settings/mutes` で確認可能） |
| `hider.ts` のリファクタで Phase 7 が壊れる | **M** | 中 | **既存テストを 1 つも書き換えないことを合格条件にする**。`hider.ts` は現在 100% カバー |
| `busy` フラグでポップアップが数秒固まる | M | 小 | 押した直後に「ミュートしています…」を出す。連打で二重実行しないことの方が重要 |
| ミュートした著者が視界から消えて再評価できない（OQ-16） | M | 中 | **評価 → ミュートの順序は崩れない**（「妥当」が先）。`settings/mutes` で回収できる。既定オフなので、適合率を測る段階では発動しない |

---

## Notes

### この Phase が記事の素材として持つもの

| 素材 | 内容 |
|---|---|
| **教訓が先回りで効いた初めての例** | 「storage の変更通知は操作の通知ではない」は Phase 7 の実機バグから得た教訓だった。今回は**設計の段階でそれを適用**し、`onChanged` にミュートをぶら下げる案を書く前に捨てた。既に「妥当」を押してある 2 件が永久にミュートされない不具合を、実機に出す前に消している |
| **危険な選択肢が安全な選択肢の真上にある** | メニューは「フォロー / **ブロック** / ミュート」。1 つ上を押すと回収不能。**インデックスをコードのどこにも書かない**という制約が、そこから導かれた |
| **知らない方が安全な情報がある** | ミュート解除の文言を調べれば「既にミュート済み」を判別できて UI が良くなる。**だが調べない** — 実装がその文字列を知った瞬間、それを押す経路が生まれる。完全一致で「一致しなければ何もしない」に閉じる方が強い |
| **Phase 7 が Phase 8 の敵になった** | 「妥当」で隠す機能が、「妥当」でミュートする機能の邪魔をする。同じトリガーから 2 つの副作用が非同期に走り、順序が保証されない。**先に作った機能が後の機能の前提を壊す**という、Phase 4b の「契機を変えると、変えていないコードの前提が壊れる」と同じ形 |
| **PRD の Success signal が古くなっていた** | 「1 クリックで複数件」と書いてあったが、ユーザーの要望は「1 件ずつ、押した瞬間に」だった。**PRD は書いた時点の理解を固定するので、実装前に読み直すと必ずずれている** |

### 意図的に測らないことにしたもの

- **ミュート解除の文言**（上記）
- **ミュートの件数上限**（OQ-2。案 A なら 1 回 1 件なので、上限に届くのはずっと先）
- **`aria-expanded` の値**。開閉の判定に使えるが、`aria-controls` が取れるかどうかで足りる。**状態を 2 箇所から読むと、食い違ったときの正解が無くなる**
