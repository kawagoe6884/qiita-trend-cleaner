# Plan: 基盤構築 (Foundation Scaffold)

## Summary

Qiita Trend Guard の土台を作る。Vite + TypeScript による Manifest V3 のビルド構成、`manifest.config.ts`、service worker と content script の骨格、そして**このプロジェクトで最も壊れやすい箇所である DOM セレクタを 1 ファイルに隔離する構造**を確立する。Phase 3 以降のすべてのフェーズがここで決めた規約・型・ディレクトリ構成を踏襲する。

## User Story

As a **本拡張の開発者**,
I want **未パック拡張として Chrome に読み込め、qiita.com で content script が確実に動く土台**,
So that **以降のフェーズが「動くかどうか」ではなく「何を作るか」だけに集中できる**.

## Problem → Solution

**現状**: リポジトリは実質空（`Qiita API v2.txt` のみ）。ビルド構成もディレクトリ規約も型も存在せず、どのフェーズも着手できない。

**目標**: `npm run build` → `dist/` を Chrome に読み込む → qiita.com を開くと content script が起動し service worker と疎通する。加えて、**セレクタが 1 ファイルに集約され、CSS-in-JS のハッシュクラス名を使えない仕組みがテストで機械的に強制されている**。

## Metadata

- **Complexity**: **Medium**（新規ファイル 18 件前後、ロジックは薄いが規約決定が多い）
- **Source PRD**: `.claude/PRPs/prds/qiita-trend-guard.prd.md`
- **PRD Phase**: Phase 2 — 基盤構築
- **Estimated Files**: 18 (すべて CREATE)
- **Dependencies**: なし（PRD 上 Phase 2 は依存なし。Phase 1 は complete）

---

## ⚠️ このフェーズの特殊性 — 踏襲すべき既存パターンは存在しない

`/prp-plan` は通常「コードベースを探索して既存パターンを抽出し、それを鏡写しにする」。**しかし本プロジェクトのコードベースは空である。**

```
$ ls -R
Qiita API v2.txt
.claude/PRPs/prds/qiita-trend-guard.prd.md
```

したがって本計画の「Patterns」セクションは、**発見したパターンではなく、これから確立し以降のフェーズが踏襲するパターン**である。実在しないファイルへの `SOURCE:` 参照は一切書かない。以降のフェーズの計画では、本フェーズで作られた実ファイルを `SOURCE:` として参照すること。

---

## UX Design

### Before

```
┌──────────────────────────────────────┐
│ chrome://extensions                  │
│                                      │
│  （Qiita Trend Guard は存在しない）   │
│                                      │
│ qiita.com を開いても何も起きない      │
└──────────────────────────────────────┘
```

### After

```
┌──────────────────────────────────────┐
│ chrome://extensions                  │
│  ┌────────────────────────────────┐  │
│  │ 🛡 Qiita Trend Guard   0.1.0   │  │
│  │   ID: <生成される>              │  │
│  │   [詳細] [再読み込み] [削除]     │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
        ↓ qiita.com を開く
┌──────────────────────────────────────┐
│ DevTools Console                     │
│ [QTG] content script ready           │
│ [QTG] service worker pong: 0.1.0     │
│                                      │
│ <html data-qtg-injected="0.1.0">     │
└──────────────────────────────────────┘
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| chrome://extensions | 未登録 | 未パック拡張として登録・再読み込み可能 | Web Store 公開は Phase 9 以降 |
| qiita.com 表示 | 変化なし | `<html>` に `data-qtg-injected` が付く | **この時点では記事の見た目は一切変わらない**（非表示は Phase 7） |
| 拡張アイコン | なし | ポップアップが開き「未設定」と表示 | 実機能は Phase 3 以降 |
| オプション画面 | なし | 空のプレースホルダが開く | 実設定は Phase 3 / 6 |

---

## Mandatory Reading

コードベースが空のため、読むべきは PRD と外部ドキュメントのみ。

| Priority | File | Lines | Why |
|---|---|---|---|
| **P0** | `.claude/PRPs/prds/qiita-trend-guard.prd.md` | 「DOM セレクタ戦略」節 | **`.style-*` 使用禁止の根拠と代替セレクタの優先順位。Task 6 の全内容がここに依存** |
| **P0** | 同上 | 「Architecture Notes」「ストレージ設計」節 | service worker / content script の責務分担、`storage.local` と `storage.sync` の使い分け、データ構造 |
| **P1** | 同上 | 「Technical Risks」表 | フェイルセーフ方針（取得失敗時は**何もしない**）。Task 6 の設計方針 |
| **P1** | 同上 | 「Implementation Phases」表 | Phase 3〜10 が本フェーズの成果物に何を期待しているか |
| **P2** | 同上 | 「Decisions Log」 | 技術スタック選定の理由。@crxjs 採用判断の前提 |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| MV3 manifest キー | [Chrome Extensions manifest リファレンス](https://developer.chrome.com/docs/extensions/reference/manifest) | `permissions` と `host_permissions` は**別キー**。`storage` / `alarms` は `permissions`、`https://qiita.com/*` は `host_permissions` |
| @crxjs/vite-plugin | [crxjs/chrome-extension-tools](https://github.com/crxjs/chrome-extension-tools) / [npm](https://www.npmjs.com/package/@crxjs/vite-plugin) | v2.0 (2025-06) で安定版。Vite 3〜8 対応。`manifest.config.ts` を入口に content script / SW のバンドルを自動処理。HMR 対応 |
| Vitest グローバルモック | [Vitest — Mocking Globals](https://vitest.dev/guide/mocking/globals) | `vi.stubGlobal` で `globalThis.chrome` を差し替え。`unstubGlobals: true` で各テスト後に自動復元 |
| chrome.storage 上限 | [chrome.storage リファレンス](https://developer.chrome.com/docs/extensions/reference/api/storage) | `local` = 10 MB / `sync` = 100 KB・8 KB per item・512 items・1800 writes per hour |

---

## Patterns to Establish

以降のフェーズはこれらを**そのまま**踏襲すること。

### NAMING_CONVENTION

```
ディレクトリ         : src/<責務>/        (background, content, dom, lib, types, test, ui)
ファイル             : camelCase.ts       (selectors.ts, feedClient.ts)
エントリポイント      : index.ts           (src/background/index.ts)
型・インターフェース  : PascalCase         (TrendItem, LikeRecord, Settings)
関数・変数           : camelCase          (findSnackbar, lastFeedUpdated)
定数                : UPPER_SNAKE_CASE   (SNACKBAR_TEXT, DEFAULT_SETTINGS)
真偽値              : is/has/should/can 接頭辞 (hasDescription, isMuted)
テスト              : <対象>.test.ts を対象と同ディレクトリ (selectors.test.ts)
ログ接頭辞           : [QTG]
```

### ERROR_HANDLING — フェイルセーフ原則

**DOM 取得の失敗は例外を投げず `null` を返す。** PRD の Technical Risks が定めた「取得失敗時は**何もしない**（誤った対象をミュートするより無害）」の実装形。

```ts
// src/dom/selectors.ts で確立
export function querySnackbarContainer(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SELECTORS.snackbarContainer);
}

// 呼び出し側は必ず null チェックし、null なら何もせず抜ける
const container = querySnackbarContainer();
if (!container) {
  logger.warn('snackbar container not found — skipping');
  return;
}
```

一方、**設定値の不正やネットワーク層の失敗は明示的に throw する**（Phase 4 の API クライアントで使う）。

```ts
// src/lib/errors.ts で確立
export class QtgError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'QtgError';
  }
}
```

### LOGGING_PATTERN

`console` を直接呼ばず、接頭辞を強制する薄いラッパーを通す。本番ビルドで無効化する余地も残る。

```ts
// src/lib/logger.ts で確立
const PREFIX = '[QTG]';
export const logger = {
  debug: (...a: unknown[]) => console.debug(PREFIX, ...a),
  info:  (...a: unknown[]) => console.info(PREFIX, ...a),
  warn:  (...a: unknown[]) => console.warn(PREFIX, ...a),
  error: (...a: unknown[]) => console.error(PREFIX, ...a),
};
```

**禁止**: `console.log` の直接呼び出し（ECC コードレビュー基準「No console.log or debug statements」への準拠）。ESLint で機械的に強制する。

### SELECTOR_PATTERN — 本フェーズの中核

セレクタ文字列は `src/dom/selectors.ts` の外に一切書かない。**CSS-in-JS のハッシュクラス名（`.style-*`）は禁止**で、これをテストで機械的に強制する。

```ts
// src/dom/selectors.ts で確立
export const SELECTORS = {
  /** Snackbar のコンテナ。React コンポーネント名は安定、uuid サフィックスのみ可変 */
  snackbarContainer: '[id^="Snackbar-react-component-"]',
  /** ARIA ライブリージョン。属性は事実上の契約で変更されにくい */
  snackbarLiveRegion: '[aria-live="polite"][aria-atomic="true"]',
  /** Snackbar 内のメッセージ本文 */
  snackbarMessage: 'p',
} as const;

export const SNACKBAR_TEXT = {
  muteCompleted: 'ミュートが完了しました',
  unmuteCompleted: 'ミュートの解除が完了しました',
} as const;
```

### MESSAGE_PATTERN — content script ⇄ service worker

型付きの判別可能ユニオンで往復させる。`any` を挟まない。

```ts
// src/types/messages.ts で確立
export type QtgRequest =
  | { type: 'PING' };

export type QtgResponse =
  | { type: 'PONG'; version: string };
```

### TEST_STRUCTURE — AAA パターン

```ts
// src/dom/selectors.test.ts で確立
import { describe, it, expect } from 'vitest';
import { SELECTORS } from './selectors';

describe('SELECTORS', () => {
  it('CSS-in-JS のハッシュクラス名を含まない', () => {
    // Arrange
    const values = Object.values(SELECTORS);
    // Act
    const offenders = values.filter((v) => /\.style-/.test(v));
    // Assert
    expect(offenders).toEqual([]);
  });
});
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `package.json` | CREATE | 依存とスクリプトの定義 |
| `.gitignore` | CREATE | `node_modules` / `dist` / `.env` を除外 |
| `tsconfig.json` | CREATE | strict モードの TypeScript 設定 |
| `tsconfig.node.json` | CREATE | vite.config.ts 用（Node 環境の型） |
| `vite.config.ts` | CREATE | @crxjs プラグインの登録、Vitest 設定 |
| `manifest.config.ts` | CREATE | MV3 マニフェスト定義 |
| `src/lib/logger.ts` | CREATE | ログ接頭辞の強制 |
| `src/lib/errors.ts` | CREATE | `QtgError` の定義 |
| `src/types/domain.ts` | CREATE | PRD のストレージスキーマを型化。**Phase 4〜8 の契約** |
| `src/types/messages.ts` | CREATE | content script ⇄ SW のメッセージ型 |
| `src/dom/selectors.ts` | CREATE | **本フェーズの中核。**セレクタの唯一の置き場 |
| `src/dom/selectors.test.ts` | CREATE | `.style-*` 禁止の機械的強制 |
| `src/background/index.ts` | CREATE | service worker 骨格。PING に PONG を返す |
| `src/content/index.ts` | CREATE | content script 骨格。注入マーカーと疎通確認 |
| `src/ui/popup/index.html` / `main.ts` | CREATE | ポップアップのプレースホルダ |
| `src/ui/options/index.html` / `main.ts` | CREATE | オプション画面のプレースホルダ |
| `src/test/setup.ts` | CREATE | `vi.stubGlobal` による chrome API モック |
| `eslint.config.js` | CREATE | Flat Config。`no-console` を含む |
| `.prettierrc.json` | CREATE | フォーマット統一 |
| `public/icons/icon-{16,48,128}.png` | CREATE | プレースホルダアイコン |
| `README.md` | CREATE | 未パック読み込み手順 |

## NOT Building

以下は**本フェーズでは作らない**。着手しかけたら手を止めること。

- ❌ **Atom フィードの取得・パース** → Phase 4
- ❌ **Qiita API クライアント / アクセストークンの入力 UI** → Phase 3・4
- ❌ **共起クラスタ検出・バースト判定のロジック** → Phase 5
- ❌ **候補一覧 UI・スライダー・適合率フィードバック** → Phase 6
- ❌ **記事の非表示処理・除外件数バッジ** → Phase 7
- ❌ **ミュートの自動実行・Snackbar の MutationObserver 監視** → Phase 8（Task 6 で*セレクタ定数と読み取り関数だけ*先に置くが、それを使う監視ループは書かない）
- ❌ **トレンドカードや「⋯」メニューのセレクタ** → 実 DOM が未取得（PRD の OQ-9 残件）。**推測で書かない**
- ❌ `chrome.storage` への実際の読み書き → Phase 4（型だけ定義する）
- ❌ CI / GitHub Actions → Web Store 公開を検討する段階で
- ❌ 多言語対応・ダークモード・アイコンのデザイン

---

## Step-by-Step Tasks

### Task 1: プロジェクト初期化

- **ACTION**: `package.json`、`.gitignore`、ディレクトリ骨格を作る
- **IMPLEMENT**:
  ```bash
  npm init -y
  npm i -D typescript vite @crxjs/vite-plugin @types/chrome vitest jsdom \
           eslint typescript-eslint @eslint/js prettier
  mkdir -p src/background src/content src/dom src/lib src/types src/test \
           src/ui/popup src/ui/options public/icons
  ```
  `package.json` に追記:
  ```json
  {
    "type": "module",
    "version": "0.1.0",
    "scripts": {
      "dev": "vite",
      "build": "tsc --noEmit && vite build",
      "typecheck": "tsc --noEmit",
      "test": "vitest run",
      "test:watch": "vitest",
      "lint": "eslint .",
      "format": "prettier --write ."
    }
  }
  ```
  `.gitignore`: `node_modules/`, `dist/`, `.env*`, `*.local`
- **MIRROR**: NAMING_CONVENTION のディレクトリ規約
- **GOTCHA**: **`"type": "module"` を必ず入れる。**無いと `vite.config.ts` と `manifest.config.ts` の ESM 解決が壊れる
- **GOTCHA**: `@crxjs/vite-plugin` は **2.x が解決されることを確認**する（`npm view @crxjs/vite-plugin version`）。1.x は 3 年続いたベータ系列で API が異なる
- **VALIDATE**: `npm ls @crxjs/vite-plugin` が 2.x を返し、`ls src` が 7 ディレクトリを表示する

### Task 2: TypeScript 設定

- **ACTION**: `tsconfig.json` と `tsconfig.node.json` を作る
- **IMPLEMENT**: `tsconfig.json`
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "lib": ["ES2022", "DOM", "DOM.Iterable"],
      "module": "ESNext",
      "moduleResolution": "bundler",
      "strict": true,
      "noUncheckedIndexedAccess": true,
      "noImplicitOverride": true,
      "exactOptionalPropertyTypes": true,
      "noUnusedLocals": true,
      "noUnusedParameters": true,
      "isolatedModules": true,
      "verbatimModuleSyntax": true,
      "resolveJsonModule": true,
      "skipLibCheck": true,
      "noEmit": true,
      "types": ["chrome", "vitest/globals"]
    },
    "include": ["src", "manifest.config.ts", "vite.config.ts"]
  }
  ```
- **GOTCHA**: `"types": ["chrome"]` を入れないと `chrome.*` が未定義扱いになる。`@types/chrome` を入れただけでは効かない
- **GOTCHA**: `noUncheckedIndexedAccess` は配列・インデックスアクセスが `T | undefined` になるため書き味が変わる。**Phase 5 の共起インデックス実装で効いてくる安全装置なので、ここで入れておく**（後から入れると全面修正になる）
- **GOTCHA**: `resolveJsonModule` を入れないと `manifest.config.ts` から `package.json` を読めない
- **VALIDATE**: `npm run typecheck` がエラー 0 で完了する

### Task 3: manifest.config.ts

- **ACTION**: MV3 マニフェストを TypeScript で定義する
- **IMPLEMENT**:
  ```ts
  import { defineManifest } from '@crxjs/vite-plugin';
  import pkg from './package.json' with { type: 'json' };

  export default defineManifest({
    manifest_version: 3,
    name: 'Qiita Trend Guard',
    version: pkg.version,
    description:
      'Qiita のトレンドから、不自然ないいねパターンが検出された記事を隠します。',
    icons: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    permissions: ['storage', 'alarms'],
    host_permissions: ['https://qiita.com/*'],
    background: { service_worker: 'src/background/index.ts', type: 'module' },
    content_scripts: [
      {
        matches: ['https://qiita.com/*'],
        js: ['src/content/index.ts'],
        run_at: 'document_idle',
      },
    ],
    action: { default_popup: 'src/ui/popup/index.html' },
    options_page: 'src/ui/options/index.html',
  });
  ```
- **IMPORTS**: `defineManifest` from `@crxjs/vite-plugin`
- **GOTCHA**: **`storage` と `alarms` は `permissions`、`https://qiita.com/*` は `host_permissions`。**逆に書くと無言で無視され、実行時に初めて失敗する
- **GOTCHA**: `description` は 132 文字上限、`name` は 75 文字上限
- **GOTCHA**: UI 文言は「不正アカウント」と断定せず「不自然ないいねパターン」に留める（PRD の Technical Risks の緩和策）
- **GOTCHA**: Phase 7 でちらつきのない非表示を実装する際、`run_at: 'document_start'` の CSS 注入用 content script を**追加**する必要が出る可能性が高い。今は `document_idle` のまま置き、Phase 7 で判断する
- **VALIDATE**: `npm run build` 後、`dist/manifest.json` に `permissions` / `host_permissions` / `background` / `content_scripts` の 4 キーがすべて存在する

### Task 4: vite.config.ts

- **ACTION**: @crxjs プラグインと Vitest を設定する
- **IMPLEMENT**:
  ```ts
  /// <reference types="vitest/config" />
  import { defineConfig } from 'vite';
  import { crx } from '@crxjs/vite-plugin';
  import manifest from './manifest.config';

  export default defineConfig({
    plugins: [crx({ manifest })],
    build: { outDir: 'dist', emptyOutDir: true },
    publicDir: 'public',
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      unstubGlobals: true,
    },
  });
  ```
- **IMPORTS**: `crx` from `@crxjs/vite-plugin`
- **GOTCHA**: 先頭の `/// <reference types="vitest/config" />` が無いと `test` キーで型エラーになる
- **GOTCHA**: `unstubGlobals: true` を入れないと `vi.stubGlobal` した `chrome` がテスト間で漏れる
- **VALIDATE**: `npm run build` が成功し `dist/` が生成される

### Task 5: 型定義（Phase 4〜8 の契約）

- **ACTION**: PRD のストレージスキーマを TypeScript の型に落とす
- **IMPLEMENT**: `src/types/domain.ts`
  ```ts
  /** ISO 8601 (JST オフセット付き) の日時文字列。例: "2026-08-18T17:00:00+09:00" */
  export type IsoDateTime = string;

  /** Qiita のユーザーハンドル（API の User.id） */
  export type AccountHandle = string;

  /** Qiita の記事 ID */
  export type ItemId = string;

  /** Atom フィードの 1 エントリ */
  export interface TrendItem {
    itemId: ItemId;
    url: string;
    authorHandle: AccountHandle;
    publishedAt: IsoDateTime;
  }

  /** あるアカウントによる 1 件のいいね */
  export interface LikeRecord {
    itemId: ItemId;
    authorHandle: AccountHandle;
    /** Like.created_at */
    likedAt: IsoDateTime;
    /** バースト判定用。記事の投稿時刻 */
    itemPostedAt: IsoDateTime;
  }

  /** アカウント単位の逆引きインデックス */
  export interface AccountIndexEntry {
    likes: LikeRecord[];
    itemsCount: number;
    followersCount: number;
    hasDescription: boolean;
  }

  export type LikeIndex = Record<AccountHandle, AccountIndexEntry>;

  export type Verdict = 'valid' | 'false_positive';

  /** 検出された組織票の候補 */
  export interface Candidate {
    authorHandle: AccountHandle;
    clusterAccounts: AccountHandle[];
    /** M: 共通していいねされた記事数 */
    sharedItemCount: number;
    /** N: クラスタを構成するアカウント数 */
    clusterSize: number;
    /** 0.0-1.0 */
    burstScore: number;
    detectedAt: IsoDateTime;
    verdict: Verdict | null;
  }

  /** storage.sync に置く設定 */
  export interface Settings {
    minClusterSize: number;
    minSharedItems: number;
    lookbackDays: number;
  }

  export const DEFAULT_SETTINGS: Settings = {
    minClusterSize: 5,
    minSharedItems: 2,
    lookbackDays: 3,
  };

  /** storage.local のスキーマ全体 */
  export interface LocalState {
    token?: string;
    lastFeedUpdated?: IsoDateTime;
    feedETag?: string;
    likeIndex: LikeIndex;
    candidates: Candidate[];
    purgeAfter?: IsoDateTime;
  }
  ```
  `src/types/messages.ts` は MESSAGE_PATTERN の節の内容をそのまま。
- **MIRROR**: NAMING_CONVENTION（型は PascalCase、定数は UPPER_SNAKE_CASE）
- **GOTCHA**: `token` は **`storage.local` に置く**（PRD の決定 — 同期による漏出面の拡大を避ける）。`Settings` に含めないこと
- **GOTCHA**: 日時はすべて `IsoDateTime`（文字列）で持つ。`Date` は `chrome.storage` で JSON シリアライズされ復元時に文字列に戻るため、型と実体がずれる
- **VALIDATE**: `npm run typecheck` がエラー 0

### Task 6: DOM セレクタ層 ★本フェーズの中核

- **ACTION**: セレクタを 1 ファイルに隔離し、フェイルセーフな取得関数を用意する
- **IMPLEMENT**: `src/dom/selectors.ts`
  ```ts
  /**
   * Qiita の DOM セレクタの唯一の置き場。
   *
   * 【禁止】CSS-in-JS が生成したハッシュクラス名（.style-5ctx60 等）を書かないこと。
   *        Qiita がビルドし直すたびに変わるため、次のデプロイで確実に壊れる。
   *        selectors.test.ts が機械的に検査している。
   *
   * 【使ってよいもの】id プレフィックス / ARIA 属性 / テキスト一致 / 安定した data 属性
   */
  export const SELECTORS = {
    snackbarContainer: '[id^="Snackbar-react-component-"]',
    snackbarLiveRegion: '[aria-live="polite"][aria-atomic="true"]',
    snackbarMessage: 'p',
  } as const;

  export const SNACKBAR_TEXT = {
    muteCompleted: 'ミュートが完了しました',
    unmuteCompleted: 'ミュートの解除が完了しました',
  } as const;

  /** 拡張が注入済みであることを示すマーカー属性（dataset のキー名） */
  export const INJECTION_MARKER = 'qtgInjected';

  /** 見つからなければ null。例外は投げない（フェイルセーフ原則） */
  export function querySnackbarContainer(root: ParentNode = document): HTMLElement | null {
    return root.querySelector<HTMLElement>(SELECTORS.snackbarContainer);
  }

  /** Snackbar の現在のメッセージ本文。無ければ null */
  export function readSnackbarMessage(root: ParentNode = document): string | null {
    const container = querySnackbarContainer(root);
    if (!container) return null;
    const p = container.querySelector<HTMLElement>(SELECTORS.snackbarMessage);
    return p?.textContent?.trim() ?? null;
  }
  ```
- **MIRROR**: SELECTOR_PATTERN、ERROR_HANDLING（null を返す）
- **GOTCHA**: **`readSnackbarMessage` は Phase 8 で使う読み取り関数であって、監視ループではない。**`MutationObserver` による待機処理は Phase 8 のスコープ。ここで書かないこと
- **GOTCHA**: トレンドカードや「⋯」メニューのセレクタは**実 DOM が未取得**（PRD の OQ-9 残件）。**推測で追加しない。**空のまま Phase 7 / 8 で埋める
- **VALIDATE**: `npm run test` で Task 10 のテストが通る

### Task 7: ログ・エラーユーティリティ

- **ACTION**: `src/lib/logger.ts` と `src/lib/errors.ts` を作る
- **IMPLEMENT**: LOGGING_PATTERN と ERROR_HANDLING の節に示したコードをそのまま
- **MIRROR**: LOGGING_PATTERN / ERROR_HANDLING
- **GOTCHA**: `logger` 内部の `console.*` は ESLint の `no-console` に引っかかる。`eslint.config.js` で **`src/lib/logger.ts` だけ `no-console` を off** にする（Task 12）
- **VALIDATE**: `npm run lint` がエラー 0

### Task 8: service worker 骨格

- **ACTION**: PING に PONG を返すだけの service worker を作る
- **IMPLEMENT**: `src/background/index.ts`
  ```ts
  import { logger } from '../lib/logger';
  import type { QtgRequest, QtgResponse } from '../types/messages';

  const VERSION = chrome.runtime.getManifest().version;

  chrome.runtime.onInstalled.addListener((details) => {
    logger.info('installed:', details.reason, 'version:', VERSION);
  });

  chrome.runtime.onMessage.addListener(
    (message: QtgRequest, _sender, sendResponse: (r: QtgResponse) => void) => {
      if (message.type === 'PING') {
        sendResponse({ type: 'PONG', version: VERSION });
      }
      return false; // 同期応答のみ
    },
  );

  logger.info('service worker booted', VERSION);
  ```
- **IMPORTS**: `logger`、`QtgRequest` / `QtgResponse`（型は `import type` で）
- **MIRROR**: MESSAGE_PATTERN、LOGGING_PATTERN
- **GOTCHA**: **MV3 の service worker は一定時間で停止する。**トップレベル変数に状態を保持してはいけない。永続化は `chrome.storage`（Phase 4）
- **GOTCHA**: `onMessage` で非同期応答する場合のみ `return true`。**同期応答で `true` を返すとチャネルが開きっぱなしになる**
- **GOTCHA**: `verbatimModuleSyntax: true` のため、型のみのインポートは `import type` が必須（そうしないとビルドエラー）
- **VALIDATE**: 拡張を読み込み、`chrome://extensions` の「Service Worker」リンクから DevTools を開くと `[QTG] service worker booted 0.1.0` が出る

### Task 9: content script 骨格

- **ACTION**: 注入マーカーを付け、service worker と疎通する
- **IMPLEMENT**: `src/content/index.ts`
  ```ts
  import { logger } from '../lib/logger';
  import { INJECTION_MARKER } from '../dom/selectors';
  import type { QtgRequest, QtgResponse } from '../types/messages';

  function markInjected(version: string): void {
    document.documentElement.dataset[INJECTION_MARKER] = version;
  }

  async function ping(): Promise<void> {
    const request: QtgRequest = { type: 'PING' };
    try {
      const response = (await chrome.runtime.sendMessage(request)) as QtgResponse | undefined;
      if (response?.type === 'PONG') {
        markInjected(response.version);
        logger.info('service worker pong:', response.version);
      } else {
        logger.warn('unexpected response from service worker');
      }
    } catch (error) {
      // service worker 起動中などで失敗しうる。握りつぶさずログに残す
      logger.error('failed to reach service worker:', error);
    }
  }

  logger.info('content script ready');
  void ping();
  ```
- **IMPORTS**: `logger`、`INJECTION_MARKER`、メッセージ型
- **MIRROR**: MESSAGE_PATTERN、LOGGING_PATTERN、ERROR_HANDLING
- **GOTCHA**: `chrome.runtime.sendMessage` は **service worker が起動中だと reject しうる。**必ず `try/catch` する。ここを握りつぶすと Phase 4 以降で原因不明の無反応になる
- **GOTCHA**: content script は**分離ワールド**で動く。ページ側の JS 変数には触れない。`window.alert` の上書きも（PRD が Won't にした通り）ここからは不可能
- **VALIDATE**: qiita.com を開き DevTools Console に 2 行のログ、Elements で `<html data-qtg-injected="0.1.0">` を確認

### Task 10: テスト基盤と セレクタ検査テスト

- **ACTION**: chrome API モックを用意し、`.style-*` 禁止を機械的に強制する
- **IMPLEMENT**: `src/test/setup.ts`
  ```ts
  import { vi, beforeEach } from 'vitest';

  function createStorageArea() {
    const store = new Map<string, unknown>();
    return {
      get: vi.fn(async (keys?: string | string[] | null) => {
        if (keys == null) return Object.fromEntries(store);
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) store.set(k, v);
      }),
      remove: vi.fn(async (key: string) => void store.delete(key)),
      clear: vi.fn(async () => store.clear()),
    };
  }

  function createChromeMock() {
    return {
      runtime: {
        getManifest: vi.fn(() => ({ version: '0.0.0-test' })),
        sendMessage: vi.fn(),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
      },
      storage: { local: createStorageArea(), sync: createStorageArea() },
      alarms: { create: vi.fn(), clear: vi.fn(), onAlarm: { addListener: vi.fn() } },
    };
  }

  beforeEach(() => {
    vi.stubGlobal('chrome', createChromeMock());
  });
  ```
  `src/dom/selectors.test.ts`: TEST_STRUCTURE の節のテストに加えて、
  ```ts
  it('Snackbar のメッセージを読み取れる', () => {
    // Arrange
    document.body.innerHTML = `
      <div id="Snackbar-react-component-5c3764b3-27d6-4d3a-9c08-7437191f2087">
        <div aria-live="polite" aria-atomic="true">
          <div><p>ミュートが完了しました</p></div>
        </div>
      </div>`;
    // Act
    const message = readSnackbarMessage();
    // Assert
    expect(message).toBe(SNACKBAR_TEXT.muteCompleted);
  });

  it('Snackbar が無ければ null を返し、例外を投げない', () => {
    document.body.innerHTML = '';
    expect(() => readSnackbarMessage()).not.toThrow();
    expect(readSnackbarMessage()).toBeNull();
  });

  it('uuid が異なっても id プレフィックスで一致する', () => {
    document.body.innerHTML = `
      <div id="Snackbar-react-component-00000000-1111-2222-3333-444444444444">
        <div aria-live="polite" aria-atomic="true"><div><p>ミュートの解除が完了しました</p></div></div>
      </div>`;
    expect(readSnackbarMessage()).toBe(SNACKBAR_TEXT.unmuteCompleted);
  });

  it('メッセージ要素が欠けていても null を返す', () => {
    document.body.innerHTML = `
      <div id="Snackbar-react-component-abc">
        <div aria-live="polite" aria-atomic="true"></div>
      </div>`;
    expect(readSnackbarMessage()).toBeNull();
  });
  ```
- **MIRROR**: TEST_STRUCTURE（AAA）
- **GOTCHA**: HTML フィクスチャに**実際のハッシュクラス（`class="style-5ctx60"`）を書かない。**書くとテストが「壊れやすいセレクタでも通る」ことを追認してしまう。**あえて class 属性を落としたフィクスチャにすることで、クラス名に依存していないことを証明する**
- **GOTCHA**: `environment: 'jsdom'` が効いていないと `document` が未定義になる
- **VALIDATE**: `npm run test` が全件パス

### Task 11: UI プレースホルダ

- **ACTION**: ポップアップとオプション画面の最小 HTML を置く
- **IMPLEMENT**: `src/ui/popup/index.html` は `<div id="app">Qiita Trend Guard — 未設定</div>` と `<script type="module" src="./main.ts"></script>`。`main.ts` は `logger.info('popup opened')` のみ。オプション画面も同様
- **GOTCHA**: @crxjs は `manifest.config.ts` から参照された HTML を自動で入口として扱う。`vite.config.ts` の `rollupOptions.input` に手で足さないこと（二重登録になる）
- **VALIDATE**: 拡張アイコンのクリックでポップアップが開く。`chrome://extensions` の「拡張機能のオプション」でオプション画面が開く

### Task 12: Lint / Format 設定

- **ACTION**: ESLint Flat Config と Prettier を設定する
- **IMPLEMENT**: `eslint.config.js`
  ```js
  import js from '@eslint/js';
  import tseslint from 'typescript-eslint';

  export default tseslint.config(
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: { parserOptions: { projectService: true } },
      rules: {
        'no-console': 'error',
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/consistent-type-imports': 'error',
      },
    },
    { files: ['src/lib/logger.ts'], rules: { 'no-console': 'off' } },
    { ignores: ['dist/**', 'node_modules/**'] },
  );
  ```
  `.prettierrc.json`: `{ "singleQuote": true, "semi": true, "printWidth": 100 }`
- **GOTCHA**: `no-console: 'error'` は ECC のコードレビュー基準（デバッグ文の混入禁止）を機械的に強制する。**`logger.ts` だけ例外にする**のを忘れると自分の実装で詰まる
- **VALIDATE**: `npm run lint` がエラー 0

### Task 13: アイコンと README

- **ACTION**: プレースホルダアイコン 3 サイズと、未パック読み込み手順の README を置く
- **IMPLEMENT**: `public/icons/icon-{16,48,128}.png`（単色の四角で可）。`README.md` に `npm i` → `npm run build` → `chrome://extensions` → 開発者モード ON → 「パッケージ化されていない拡張機能を読み込む」→ `dist/` を選択、の 5 ステップ
- **GOTCHA**: `public/` の中身は `dist/` 直下にコピーされる。`manifest.config.ts` のパスは `icons/icon-16.png`（`public/` を含めない）
- **VALIDATE**: `dist/icons/` に 3 ファイルが存在し、`chrome://extensions` にアイコンが表示される

### Task 14: 統合確認

- **ACTION**: 実機で Success signal を満たすことを確認する
- **VALIDATE**: 下の「Manual Validation」チェックリストを全項目実施

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| SELECTORS がハッシュクラスを含まない | `SELECTORS` の全値 | `.style-` に一致する値が 0 件 | — |
| Snackbar メッセージの読み取り | ミュート完了の Snackbar DOM | `'ミュートが完了しました'` | — |
| Snackbar 解除メッセージの読み取り | 解除完了の Snackbar DOM | `'ミュートの解除が完了しました'` | — |
| uuid 差異への耐性 | 異なる uuid を持つ Snackbar | 正しくメッセージを返す | ✅ |
| Snackbar 不在 | 空の DOM | `null`。例外を投げない | ✅ |
| メッセージ要素の欠落 | `<p>` を欠く DOM | `null`。例外を投げない | ✅ |
| `DEFAULT_SETTINGS` の値 | — | `{ minClusterSize: 5, minSharedItems: 2, lookbackDays: 3 }` | — |
| chrome.storage モックの往復 | `set` → `get` | 書いた値が読める | — |

### Edge Cases Checklist

- [x] 空入力（Snackbar 不在 → `null`）
- [x] 想定外の DOM 構造（`<p>` 欠落 → `null`、例外なし）
- [x] 識別子の可変部分（uuid 差異 → プレフィックス一致で吸収）
- [ ] 最大サイズ入力 — **N/A**（本フェーズは大量データを扱わない。Phase 4 / 5 の課題）
- [ ] 同時実行 — **N/A**（Phase 4 のスキャン多重起動で扱う）
- [ ] ネットワーク失敗 — **N/A**（Phase 4）
- [x] 権限拒否相当 — service worker への到達失敗を `try/catch` してログに残す

### カバレッジ方針

ECC の基準は 80% 以上だが、**本フェーズの成果物の大半は設定ファイルと骨格であり、テスト対象となるロジックは `src/dom/selectors.ts` と `src/types/domain.ts` の定数のみ**。カバレッジ計測は Phase 5（検出エンジン）から意味を持つ。本フェーズでは**「セレクタ層のテストが存在し、`.style-*` 禁止が機械的に強制されていること」を合格条件とする**。

---

## Validation Commands

### Static Analysis

```bash
npm run typecheck
```
EXPECT: 型エラー 0

```bash
npm run lint
```
EXPECT: ESLint エラー 0

### Unit Tests

```bash
npm run test
```
EXPECT: 全テストパス（8 件前後）

### Build

```bash
npm run build
```
EXPECT: `dist/` に `manifest.json`、`assets/`、`icons/` が生成される

### マニフェスト検証

```bash
node -e "const m=JSON.parse(require('fs').readFileSync('dist/manifest.json','utf8'));console.log(JSON.stringify({permissions:m.permissions,host_permissions:m.host_permissions,bg:!!m.background,cs:(m.content_scripts||[]).length},null,2))"
```
EXPECT: `permissions: ["storage","alarms"]`、`host_permissions: ["https://qiita.com/*"]`、`bg: true`、`cs: 1`

### Manual Validation

- [ ] `chrome://extensions` で開発者モードを ON にし、`dist/` を「パッケージ化されていない拡張機能」として読み込める
- [ ] 拡張カードにアイコンと「Qiita Trend Guard 0.1.0」が表示される
- [ ] エラーバッジ（赤い「エラー」ボタン）が出ていない
- [ ] 「Service Worker」リンクから DevTools を開くと `[QTG] service worker booted 0.1.0`
- [ ] `https://qiita.com/` を開き、Console に `[QTG] content script ready` と `[QTG] service worker pong: 0.1.0`
- [ ] Elements で `<html data-qtg-injected="0.1.0">` を確認
- [ ] `https://qiita.com/trend`（ログイン状態）でも同じログが出る
- [ ] **トレンドの記事の見た目が一切変わっていない**（この時点で変化していたらスコープ逸脱）
- [ ] 拡張アイコンをクリックしてポップアップが開く
- [ ] オプション画面が開く
- [ ] `npm run dev` で HMR が動く（content script を編集して保存 → 自動反映）

---

## Acceptance Criteria

- [ ] Task 1〜14 がすべて完了
- [ ] `npm run typecheck` / `npm run lint` / `npm run test` / `npm run build` がすべて成功
- [ ] Manual Validation のチェックリストが全項目パス
- [ ] **PRD の Success signal「未パック拡張として読み込め、トレンドページで content script が動作する」を満たす**
- [ ] セレクタが `src/dom/selectors.ts` 以外に存在しない
- [ ] `.style-*` を使うと `npm run test` が落ちる

## Completion Checklist

- [ ] Patterns to Establish の 6 パターンすべてが実ファイルとして存在する
- [ ] エラー処理がフェイルセーフ原則に従っている（DOM 取得失敗 → `null`、例外なし）
- [ ] `console.*` の直接呼び出しが `src/lib/logger.ts` 以外に無い
- [ ] テストが AAA パターンに従っている
- [ ] マジックナンバーが無い（閾値は `DEFAULT_SETTINGS` に集約）
- [ ] `README.md` に未パック読み込み手順が書かれている
- [ ] **NOT Building のどれにも手を付けていない**
- [ ] 自己完結 — 実装中にコードベース検索や追加質問が不要

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| @crxjs 2.x の API が想定と異なる | M | M | Task 1 で `npm view` によりバージョンを確認。詰まった場合は @crxjs を外し、素の Vite で `rollupOptions.input` に 4 エントリを手書き＋`manifest.json` を `public/` に置く構成へフォールバック（HMR は失われるがビルドは通る） |
| `noUncheckedIndexedAccess` の書き味が重い | M | L | Phase 5 の共起インデックスで効く安全装置。**後から入れると全面修正になるため今入れる**という判断。煩雑な箇所は局所的に `??` で解消 |
| Snackbar のフィクスチャが実 DOM と乖離 | L | M | PRD に実 HTML が記録されており、それを元にしている。乖離が判明したら `selectors.test.ts` のフィクスチャを更新すれば足りる（セレクタ本体は無変更で済む設計） |
| MV3 service worker の停止で疎通確認が不安定 | L | L | `try/catch` 済み。再現したら qiita.com をリロードすれば SW が起きる |
| トレンドカードのセレクタが無いまま Phase 7 に入る | M | M | 本計画のスコープ外として明記済み。Phase 7 の計画作成時に実 DOM の提供を求める |

## Notes

### このフェーズで決めた 3 つの技術判断

| 判断 | 選択 | 却下した案 | 理由 |
|---|---|---|---|
| ビルドツール | **@crxjs/vite-plugin** | 素の Vite で多エントリ手書き | MV3 は content script のコード分割禁止・SW の module 指定など制約が多く、手書きは定型作業が増える。@crxjs は*フレームワークではなく Vite プラグイン*なので、PRD が WXT / Plasmo を却下した理由（フレームワーク固有の学習コスト）に抵触しない。HMR は content script の反復で効く |
| chrome API モック | **`vi.stubGlobal` で自前** | `vitest-chrome` | 原作に複数のフォークが並立し保守状況が不透明。Phase 2 で必要なのは `storage` と `alarms` のみで、自前なら 40 行。YAGNI |
| パッケージマネージャ | **npm** | pnpm / yarn | 追加インストールが不要で、記事の再現手順が最短になる |

### 後続フェーズへの申し送り

- **Phase 3 / 4** は `src/types/domain.ts` の `LocalState` / `Settings` を契約として使うこと。型を変えるなら PRD のストレージ設計も同時に更新する
- **Phase 7** は `run_at: 'document_start'` の CSS 注入用 content script を追加する必要が出る可能性が高い。`manifest.config.ts` の `content_scripts` は配列なので追加は容易
- **Phase 8** は `readSnackbarMessage` を `MutationObserver` でラップする。読み取り関数はここで完成しているので、監視ループだけ書けばよい
- **Phase 7 / 8 の着手前に、トレンドカードと「⋯」メニューの実 HTML が必要**（PRD の OQ-9 残件）

---

*Generated: 2026-08-18*
*Source: `.claude/PRPs/prds/qiita-trend-guard.prd.md` — Phase 2*
