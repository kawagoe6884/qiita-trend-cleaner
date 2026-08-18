# Qiita Trend Guard

Qiita のトレンド面から、組織的な「いいね」で押し上げられた記事を検出して隠す Chrome 拡張機能。

> 現在 **Phase 2（基盤構築）** まで完了。検出機能は未実装です。
> 設計は [PRD](.claude/PRPs/prds/qiita-trend-guard.prd.md) を参照してください。

## セットアップ

```bash
npm install
npm run build
```

## 未パック拡張として読み込む

1. Chrome で `chrome://extensions` を開く
2. 右上の **デベロッパーモード** を ON にする
3. **パッケージ化されていない拡張機能を読み込む** をクリック
4. このリポジトリの `dist/` ディレクトリを選択
5. `https://qiita.com/` を開き、DevTools の Console に `[QTG] content script ready` が出れば成功

## 開発

| コマンド            | 内容                    |
| ------------------- | ----------------------- |
| `npm run dev`       | HMR 付き開発サーバー    |
| `npm run build`     | 型チェック + 本番ビルド |
| `npm run typecheck` | 型チェックのみ          |
| `npm run test`      | ユニットテスト          |
| `npm run lint`      | ESLint                  |
| `npm run format`    | Prettier                |

## 設計上の約束

- **データ取得は公式 API と Atom フィードのみ。** Qiita はスクレイピングを許可していない
- **DOM セレクタは `src/dom/selectors.ts` にのみ書く。** CSS-in-JS のハッシュクラス名（`.style-*`）は使用禁止（テストで強制）
- **DOM 取得の失敗は例外を投げず `null` を返す。** 誤った対象を操作するより何もしない方が無害
- **`console` を直接呼ばない。** `src/lib/logger.ts` を通す（ESLint で強制）
