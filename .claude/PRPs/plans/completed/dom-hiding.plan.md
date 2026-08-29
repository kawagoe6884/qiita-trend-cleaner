# Plan: DOM 非表示（Phase 7）

## Summary

**評価済みの候補の記事を、表示中のトレンドページから消す。** Qiita 側のミュート反映を待たずに効く。隠すのは「妥当」を押した著者だけで、未評価のまま消えることはない — **適合率を測る前に対象が視界から消える経路を作らない**（OQ-16 と同じ形）。誤検知を戻せる導線も同時に置く。

## User Story

As a トレンドを健全化したいユーザー,
I want 妥当と判断した候補の記事が、いま見ているページから消えること,
So that ミュートを実行する前から、読みたい記事だけが並ぶ.

## Problem → Solution

| | 現状 | 後 |
|---|---|---|
| 候補の記事 | トレンドに出たまま | **評価済みのものが消える** |
| 反映のタイミング | Qiita のミュートを実行するまで何も起きない | **ポップアップで「妥当」を押した瞬間**に消える |
| 誤検知の回収 | 一度隠すと戻せない（設計次第） | **右下の表示から 1 クリックで全部戻せる** |
| content script | DOM を読むだけ | **書き換える**（Phase 7 で初めて） |

## Metadata

- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/qiita-trend-cleaner.prd.md`
- **PRD Phase**: Phase 7（DOM 非表示）
- **Estimated Files**: 8（新規 2 / 更新 6）

---

## 決定事項（この計画の前提）

### 1. 隠すのは `feedback` が `valid` の著者だけ（合意済み）

`candidates` は見ない。閾値を動かすと候補は作り直されるが、**評価は人間が積み上げた資産**で再計算では戻らない（Phase 6 で `Candidate.verdict` を `FeedbackLog` に退避した理由と同じ）。

「妥当」と判断した著者を隠し続けるのはユーザーの意思であり、その後スライダーを動かして候補から外れても関係ない。

### 2. `hidden` 属性ではなくインラインの `display: none`

CLAUDE.md の教訓:

> **CSS が hidden を殺した。** `display: flex` を足した瞬間、UA スタイルの `[hidden]{display:none}` が負けて要素が消えなくなった

**Qiita 側の CSS がカードに `display` を指定していたら `hidden` は効かない。**インラインスタイルは class より優先度が高いので確実に消える。戻せるように `dataset` でマークする。

### 3. 除外件数をバッジに載せない（**PRD の Scope から外す**）

PRD の Phase 7 Scope には「除外件数バッジ」とあるが、**載せない**。理由:

- バッジは実質 4 文字。**429 > 候補件数 > 空** の 3 つで既に埋まっている
- 候補件数は「**まだ対応していない**」を示し、行動を促す。除外件数は「**もう対応した**」の情報で、優先度が低い
- Success signal の「N 件を非表示にしました」は**ページ内で満たせる**

バッジを触らないので `badge.ts` は変更しない。

### 4. 戻す導線を最初から置く

OQ-16（誤検知でミュートすると視界から消え、再評価できない）は非表示にも同じ形で効く。**隠しっぱなしにできる設計を作らない。**右下の固定表示から 1 クリックで全部戻せるようにする。

### 5. カードの特定は `findCard` を再利用する

実測で `<article>` がカードのルートだと分かった（OQ-9）が、**`findCard`（リンクから祖先を遡る方式）をそのまま使う**。33 記事の実データで動いている実績があり、テストもある。`article` は将来 `findCard` が壊れたときの代替として PRD に記録済み。

**新しいセレクタを増やさない。**

---

## UX Design

### Before

```
┌─ トレンド ────────────────┐
│ ▸ 記事 A（評価: 妥当）     │  ← 消えない
│ ▸ 記事 B                  │
│ ▸ 記事 C（評価: 妥当）     │  ← 消えない
│ ▸ 記事 D                  │
└──────────────────────────┘
   Qiita のミュートを実行するまで何も起きない
```

### After

```
┌─ トレンド ────────────────┐
│ ▸ 記事 B                  │
│ ▸ 記事 D                  │
│                          │
│         ┌───────────────┐│
│         │2 件を非表示中  ││ ← 右下に固定。
│         │      [表示する]││   クリックで全部戻る
│         └───────────────┘│
└──────────────────────────┘
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| トレンドページを開く | 全件出る | **評価済みが消える** | content script の起動時 |
| ポップアップで「妥当」を押す | 何も起きない | **開いているタブから即座に消える** | `chrome.storage.onChanged` で追う（message passing を使わない） |
| 「誤り」に押し直す | — | **戻る** | 同上 |
| 右下の「表示する」 | — | **全部戻る**（そのページだけ・リロードで再び隠れる） | 誤検知の回収導線 |
| 隠すものが無い | — | **表示を出さない** | 0 件のとき要素を作らない |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| **P0** | `src/content/content-script.ts` | all（80 行） | **DOM を書き換えるのは Phase 7 が初めて**。現状は読むだけ |
| **P0** | `src/dom/trend-reader.ts` | 86-94, 105-135 | `findCard` と `readTrendItems`。**カード特定を再利用する** |
| **P0** | `src/dom/selectors.ts` | all | セレクタの唯一の置き場。**ハッシュクラス禁止**（`selectors.test.ts` が検査） |
| P1 | `src/lib/storage.ts` | 117-134 | `getFeedback`。1 件壊れても全体を捨てない |
| P1 | `src/ui/popup/popup-page.ts` | 356-380 | `chrome.storage.onChanged` の購読の書き方（Phase 6 で入れた） |
| P2 | `src/dom/trend-reader.test.ts` | 1-25 | DOM フィクスチャの作り方（合成値のみ） |
| P2 | `src/types/domain.ts` | 60-64 | `FeedbackLog = Record<AccountHandle, Verdict>` |

## External Documentation

**不要。** すべて内部パターンで完結する。

---

## Patterns to Mirror

### DOM 取得の失敗は例外を投げず null（設計上の約束 3）
```ts
// SOURCE: src/dom/selectors.ts:52-57
/**
 * Snackbar のコンテナを取得する。
 * 見つからなければ null を返し、例外は投げない（フェイルセーフ原則）。
 */
export function querySnackbarContainer(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SELECTORS.snackbarContainer);
}
```
**誤った対象を隠すより、何もしない方が無害。**

### root を引数に取る（テストで任意の DOM を渡せる）
```ts
// SOURCE: src/dom/trend-reader.ts:105
export function readTrendItems(root: ParentNode = document): TrendItem[] {
```

### カードの特定
```ts
// SOURCE: src/dom/trend-reader.ts:86-94
function findCard(link: Element): Element | null {
  let current: Element | null = link.parentElement;
  for (let depth = 0; depth < MAX_CARD_DEPTH && current !== null; depth += 1) {
    if (current.querySelectorAll(SELECTORS.trendItemLink).length > LINKS_PER_CARD) return null;
    if (current.querySelector(SELECTORS.trendItemTime) !== null) return current;
    current = current.parentElement;
  }
  return null;
}
```
**export して再利用する。** 遡りすぎると必ずリンク数が超過するため、別のカードを掴むことが原理的に起きない。

### storage.onChanged の購読
```ts
// SOURCE: src/ui/popup/popup-page.ts:360-370
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('rateLimitedUntil' in changes)) return;
  ...
});
```
**message passing を使わない。** ポップアップと content script は別コンテキストだが、storage は共有されている。

### ログ（約束 4・11）
```ts
// SOURCE: src/content/content-script.ts:56
logger.debug('not a trend page:', location.pathname);
// SOURCE: src/content/content-script.ts:62
logger.info('trend items read:', items.length);
```
`console` を直接呼ばない。**想定内の失敗は `logger.debug`。**

### DOM を組む（innerHTML を使わない）
```ts
// SOURCE: src/ui/popup/popup-page.ts:121-126
function paragraph(className: string, text: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = text;
  return element;
}
```
**著者ハンドルは Qiita 由来の外部データ。** `textContent` と `createElement` だけで組む。

### テストのフィクスチャ
```ts
// SOURCE: src/dom/trend-reader.test.ts:4-9
/**
 * 1 カード分の骨格。実測どおり **記事リンクを 2 本** 持たせる。
 * フィクスチャは合成値のみ。実アカウント名・実 item_id は使わない。
 */
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/dom/hider.ts` | **CREATE** | 隠す・戻す・件数を数える |
| `src/dom/hider.test.ts` | **CREATE** | |
| `src/dom/trend-reader.ts` | UPDATE | `findCard` を export |
| `src/dom/selectors.ts` | UPDATE | 非表示マーカーと通知要素の id |
| `src/dom/selectors.test.ts` | UPDATE | ハッシュクラス禁止の検査に新しい定数を通す |
| `src/content/content-script.ts` | UPDATE | 起動時と storage 変更時に隠す |
| `src/content/content-script.test.ts` | **CREATE**（無ければ） | 配線の検査 |
| `src/ui/popup/index.html` | — | **変更なし** |

## NOT Building

- **除外件数バッジ** — 上記の決定事項 3。`badge.ts` は触らない
- **未評価の候補を隠す** — 適合率を測る前に対象が消える
- **`article` セレクタの追加** — `findCard` で足りる。新しいセレクタを増やさない
- **隠した状態の永続化** — 「表示する」を押したら**そのページだけ**戻る。リロードで再び隠れる（評価が唯一の入力）
- **アニメーション** — 消える瞬間の演出は不要
- **ミュートの実行** — Phase 8
- **message passing** — `storage.onChanged` で足りる。`types/messages.ts` は触らない

---

## Step-by-Step Tasks

### Task 1: `findCard` を export する

- **ACTION**: `trend-reader.ts` の `findCard` に `export` を付ける
- **IMPLEMENT**: 宣言を `export function findCard(link: Element): Element | null` にし、JSDoc に「Phase 7 の非表示でも使う」と 1 行足す
- **MIRROR**: `readTrendItems` と同じ export の形
- **GOTCHA**: **中身を変えない。** 33 記事の実データで動いている。触ると Phase 4b の実績が無効になる
- **VALIDATE**: `npm run test -- --run src/dom/trend-reader.test.ts` が変わらず通ること

### Task 2: セレクタと定数を足す

- **ACTION**: `selectors.ts` に非表示用の定数を追加
- **IMPLEMENT**:
  ```ts
  /** 拡張が隠した要素の目印（dataset のキー名）。戻すときの検索に使う */
  export const HIDDEN_MARKER = 'qtgHidden';

  /** 非表示の件数を知らせる要素の id。**拡張が作る要素なので Qiita 側とは無関係** */
  export const NOTICE_ID = 'qtg-hidden-notice';
  ```
- **MIRROR**: `INJECTION_MARKER` の書き方（dataset のキー名を定数にする）
- **GOTCHA**:
  - `SELECTORS` オブジェクトには**入れない**。あれは Qiita の DOM を指すものの置き場で、**拡張が作る要素は別**。混ぜると `selectors.test.ts` の「ハッシュクラス禁止」検査の意味が薄れる
  - `NOTICE_ID` は Qiita の id と衝突しない接頭辞（`qtg-`）にする
- **VALIDATE**: `selectors.test.ts` が通ること

### Task 3: 隠す・戻すロジック

- **ACTION**: `src/dom/hider.ts` を新規作成
- **IMPLEMENT**:
  ```ts
  /** 隠した結果。呼び出し側がログと通知に使う */
  export interface HideResult {
    hidden: number;
    /** 隠した著者（重複なし・昇順）。ログ用 */
    authors: AccountHandle[];
  }

  /** feedback が valid の著者の記事カードを隠す */
  export function hideJudgedAuthors(
    feedback: FeedbackLog,
    root: ParentNode = document,
  ): HideResult;

  /** 拡張が隠したものを全部戻す。戻した件数を返す */
  export function unhideAll(root: ParentNode = document): number;

  /** いま隠れている件数 */
  export function countHidden(root: ParentNode = document): number;
  ```
  `hideJudgedAuthors` の手順:
  1. `root.querySelectorAll(SELECTORS.trendItemLink)` でリンクを走査
  2. `parseItemUrl` 相当で著者を取る → **`trend-reader.ts` の `readTrendItems` を使う**（URL 検証を二重に書かない）
  3. `feedback[authorHandle] === 'valid'` なら `findCard(link)` でカードを取る
  4. カードが `null` なら**何もしない**（約束 3）
  5. `card.style.display = 'none'` と `card.dataset[HIDDEN_MARKER] = 'true'`
- **MIRROR**: `readTrendItems` の走査と `querySnackbarContainer` のフェイルセーフ
- **IMPORTS**: `import { SELECTORS, HIDDEN_MARKER } from './selectors'; import { readTrendItems, findCard } from './trend-reader'; import type { AccountHandle, FeedbackLog } from '../types/domain';`
- **GOTCHA**:
  - **既に隠したカードを二重に処理しない**（`dataset[HIDDEN_MARKER]` を見る）。件数が二重に数えられる
  - `readTrendItems` は URL で重複排除するので、**1 カードにつき 1 回**しか来ない。だが `findCard` はリンクから遡るので、**どのリンクから遡ったか**で結果が同じことを確認する
  - `style.display` を直接書く（決定事項 2）。`hidden` 属性は Qiita の CSS に負けうる
  - **`remove()` しない。** 戻せなくなる
- **VALIDATE**: 新規テストで、隠す・戻す・二重処理・カードが取れない場合を固定

### Task 4: 通知の要素

- **ACTION**: `hider.ts` に通知の描画を足す
- **IMPLEMENT**:
  ```ts
  /**
   * 「N 件を非表示中」と戻すボタン。**0 件なら要素ごと作らない。**
   * 既にあれば件数だけ書き換える（毎回作り直すとクリックの途中で消える）。
   */
  export function renderNotice(count: number, onUnhide: () => void, root?: ParentNode): void;
  ```
  - `position: fixed` で右下。**ページの構造に依存しない**
  - `textContent` と `createElement` だけで組む（`innerHTML` を使わない）
  - `z-index` は控えめに。Qiita のモーダルより上に出さない
- **MIRROR**: `popup-page.ts` の `paragraph` / `verdictButton`
- **GOTCHA**:
  - **`display` を指定するとき `[hidden]` と競合させない。**この要素は `hidden` を使わず、**0 件なら DOM から消す**
  - 件数が変わるたびに要素を作り直すと、**ボタンを押す瞬間に消える**ことがある。既存要素があれば書き換える
  - 文言は**断定しない**（約束 6）。「非表示中」であって「ブロック中」ではない
- **VALIDATE**: 0 件で要素が無いこと、件数が変わったら書き換わること

### Task 5: content script の配線

- **ACTION**: 起動時と storage 変更時に隠す
- **IMPLEMENT**:
  ```ts
  async function applyHiding(): Promise<void> {
    if (!isTrendPage(location.pathname)) return;
    const feedback = await storage.getFeedback();
    const result = hideJudgedAuthors(feedback);
    if (result.hidden > 0) logger.info('hidden:', result.hidden, 'authors:', result.authors.length);
    renderNotice(countHidden(), () => { unhideAll(); renderNotice(0, ...); });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('feedback' in changes)) return;
    void applyHiding();
  });
  ```
- **MIRROR**: `sendTrendItems` の構造（トレンドページ判定 → 処理 → ログ）
- **GOTCHA**:
  - **`sendTrendItems` より後に呼ぶ。** 先に隠すと `readTrendItems` が隠したカードも読む（`display: none` でも DOM には残るので実害は無いが、順序を明示しておく）
  - **「誤り」に押し直したときに戻す。** `feedback` が変わったら**まず `unhideAll()` してから再適用**する。差分を追うより単純で、取りこぼしが無い
  - content script は `storage` を直接読める（`chrome.storage.local` は content script からも使える）
  - トレンド以外のページでは**何もしない**。`isTrendPage` で早期 return
- **VALIDATE**: 起動時に隠れること、`feedback` の変更で追従すること、トレンド以外では何もしないこと

### Task 6: 実機確認

- **ACTION**: `npm run build` → 拡張を読み込み直す
- **VALIDATE**: 下の Manual Validation

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected | Edge? |
|---|---|---|---|
| **valid の著者のカードを隠す** | `{ 'example-author-1': 'valid' }` | `display: none` が付く | **本題** |
| **false_positive の著者は隠さない** | `{ ...: 'false_positive' }` | 何も起きない | **本題** |
| 未評価の著者は隠さない | `{}` | 何も起きない | |
| 隠した件数を返す | 2 件該当 | `hidden: 2` | |
| **二重に隠さない** | 2 回呼ぶ | `hidden` は 2 回目に 0 | ✓ |
| **カードが取れなければ何もしない** | `<time>` の無い DOM | 例外を投げず 0 件 | **フェイルセーフ** |
| `unhideAll` が戻す | 隠した後 | `display` が消える | |
| `unhideAll` は拡張が隠したものだけ戻す | Qiita 側が `display:none` にした要素 | **触らない** | ✓ |
| `countHidden` が数える | 2 件隠した後 | 2 | |
| **0 件なら通知要素を作らない** | `count: 0` | `#qtg-hidden-notice` が無い | ✓ |
| 件数が変わったら書き換える | 1 → 2 | 要素は同一・テキストだけ変わる | ✓ |
| 通知のハンドルを HTML として解釈しない | — | `textContent` のみ | **XSS** |
| **トレンド以外では何もしない** | `/example-author-1` | 隠さない | ✓ |
| `feedback` の変更で追従する | onChanged 発火 | 再適用される | |
| **「誤り」に押し直したら戻る** | valid → false_positive | 表示に戻る | **本題** |
| 空の DOM | `<body></body>` | 例外を投げず 0 件 | ✓ |

### Edge Cases Checklist

- [ ] 空入力（空 DOM・空 feedback）
- [ ] 壊れた保存値（`feedback` が壊れていても `getFeedback` が `{}` に倒す）
- [ ] 二重適用（同じページで 2 回）
- [ ] Qiita 側が既に隠している要素（触らない）
- [ ] カードが特定できない（`<time>` が無い）
- [ ] トレンド以外のページ
- [ ] 通知要素が既に存在する
- [ ] 権限拒否 → 該当なし

### 変異テスト（実装後に必ず実施）

**過去 2 回、変異を入れるまで「守っていないテスト」に気づけなかった。** 今回も必ず実施する。**アサーションが真になる経路が 2 つ無いか**を毎回確認する。

| 壊す箇所 | 落ちるべきテスト |
|---|---|
| `verdict === 'valid'` を `!== undefined` に | 「false_positive の著者は隠さない」 |
| `dataset[HIDDEN_MARKER]` のチェックを外す | 「二重に隠さない」 |
| `unhideAll` で marker を見ずに全 `display:none` を戻す | 「Qiita 側が隠した要素を触らない」 |
| `findCard` の `null` を無視して `link` を隠す | 「カードが取れなければ何もしない」 |
| 0 件でも通知要素を作る | 「0 件なら作らない」 |
| 通知を毎回作り直す | 「件数が変わったら書き換える」（要素の同一性） |
| `isTrendPage` の判定を外す | 「トレンド以外では何もしない」 |
| `feedback` 変更時に `unhideAll` を呼ばない | 「押し直したら戻る」 |

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
npm run build && cat dist/service-worker-loader.js && grep -o 'getURL("[^"]*")' dist/assets/*loader*.js
```
EXPECT: service worker と content script が**別々の正しいチャンク**を指すこと（ビルド成功は正しい配線を意味しない）

### Manual Validation（実機）

- [ ] `dist/` を未パック拡張として読み込み直す
- [ ] トレンドページを開く → **「妥当」を押した著者の記事が消えている**
- [ ] **右下に「N 件を非表示中」と「表示する」が出る**
- [ ] 「表示する」を押す → **戻る**
- [ ] リロード → **また隠れる**
- [ ] **ポップアップを開いたまま「妥当」を押す → 裏のトレンドページから即座に消える**
- [ ] 「誤り」に押し直す → **戻る**
- [ ] 評価が 1 件も無い状態 → **右下に何も出ない**
- [ ] **記事ページ・プロフィールページを開いても何も起きない**（`isTrendPage`）
- [ ] `chrome://extensions` のエラー欄が空のまま
- [ ] **Qiita のレイアウトが崩れていない**（右下の要素が他を覆っていない）

---

## Acceptance Criteria

- [ ] Task 1〜6 完了
- [ ] Validation Commands すべて通過
- [ ] 変異テスト 8 項目すべてで狙ったテストが落ちる
- [ ] **実アカウント名・記事 URL がコード・テスト・ドキュメントに 1 つも無い**
- [ ] 実機で、評価済みの記事が消え、1 クリックで戻る

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Qiita の CSS が `display: none` に勝つ** | L | **H** | インラインスタイルは class より優先。`!important` が使われていたら実機で判明する。**その場合のみ** `setProperty('display', 'none', 'important')` に切り替える |
| カード特定が失敗して**別の記事を隠す** | L | **H** | `findCard` は遡りすぎると必ず `null` を返す（リンク数超過）。誤った対象を隠すより何もしない |
| 右下の要素が Qiita の UI を覆う | M | M | `z-index` を控えめに。実機で確認 |
| **評価を消せないので隠しっぱなしになる** | M | M | 「表示する」はそのページだけ。**恒久的に戻すには「誤り」に押し直す**。この非対称を実機チェックリストに入れた |
| `storage.onChanged` が大量に発火する | L | L | `feedback` の変更だけを見る。評価は 1 クリックに 1 回 |
| Phase 8 で隠す対象とミュート対象がずれる | M | M | どちらも `feedback` の `valid` を見る。**同じ入力に揃える**ことを Phase 8 の前提に書く |

## Notes

- **PRD の Scope から「除外件数バッジ」を外した**（決定事項 3）。理由を PRD 側にも記録すること
- **`storage.onChanged` を content script で使うのは初めて。** ポップアップでは Phase 6 で実績がある
- 「表示する」で戻るのは**そのページだけ**で、リロードすると再び隠れる。**評価が唯一の入力**という設計を崩さないため。恒久的に戻したければ「誤り」に押し直す
- **Phase 8 との接続**: ミュートの対象も `feedback` の `valid`。隠す対象と揃える。ずれると「隠れているのにミュートされない」記事ができる
