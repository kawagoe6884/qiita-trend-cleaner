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
  /** Snackbar のコンテナ。React コンポーネント名は安定、uuid サフィックスのみ可変 */
  snackbarContainer: '[id^="Snackbar-react-component-"]',
  /** ARIA ライブリージョン。属性は事実上の契約で変更されにくい */
  snackbarLiveRegion: '[aria-live="polite"][aria-atomic="true"]',
  /** Snackbar 内のメッセージ本文 */
  snackbarMessage: 'p',
} as const;

/** Snackbar が表示する完了メッセージ。Phase 8 の完了検知に使う */
export const SNACKBAR_TEXT = {
  muteCompleted: 'ミュートが完了しました',
  unmuteCompleted: 'ミュートの解除が完了しました',
} as const;

/** 拡張が注入済みであることを示すマーカー（dataset のキー名） */
export const INJECTION_MARKER = 'qtgInjected';

/**
 * Snackbar のコンテナを取得する。
 * 見つからなければ null を返し、例外は投げない（フェイルセーフ原則）。
 */
export function querySnackbarContainer(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SELECTORS.snackbarContainer);
}

/**
 * Snackbar の現在のメッセージ本文を読む。
 * コンテナまたは本文要素が無ければ null。例外は投げない。
 */
export function readSnackbarMessage(root: ParentNode = document): string | null {
  const container = querySnackbarContainer(root);
  if (!container) return null;
  const message = container.querySelector<HTMLElement>(SELECTORS.snackbarMessage);
  return message?.textContent?.trim() ?? null;
}
