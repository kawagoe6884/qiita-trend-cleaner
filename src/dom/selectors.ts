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
  /**
   * トレンドカードの記事リンク。
   * URL のパス構造（/{handle}/items/{itemId}）は Qiita の実質的な公開 API であり、
   * CSS-in-JS のハッシュクラスと違ってリニューアルに耐える。
   *
   * ⚠️ 1 カードにつき 2 本ある（タイトル付きと無し）。実測で 30 カード = 60 リンク。
   *    href で重複排除すること。
   */
  trendItemLink: 'a[href*="/items/"]',
  /**
   * 投稿時刻。datetime 属性は HTML 標準で、秒精度の ISO 8601（UTC）が入る。
   * 表示テキスト（「2026年08月18日」）は UTC との日付ずれがあるため読まない。
   */
  trendItemTime: 'time[datetime]',
} as const;

/** Snackbar が表示する完了メッセージ。Phase 8 の完了検知に使う */
export const SNACKBAR_TEXT = {
  muteCompleted: 'ミュートが完了しました',
  unmuteCompleted: 'ミュートの解除が完了しました',
} as const;

/** 拡張が注入済みであることを示すマーカー（dataset のキー名） */
export const INJECTION_MARKER = 'qtgInjected';

/**
 * 拡張が隠した要素の目印（dataset のキー名）。
 *
 * **戻すときに「拡張が隠したものだけ」を選ぶために要る。**これが無いと
 * Qiita 自身が `display: none` にしている要素まで表示してしまう。
 */
export const HIDDEN_MARKER = 'qtgHidden';

/**
 * 非表示の件数を知らせる要素の id。**拡張が作る要素なので Qiita の DOM とは無関係。**
 * SELECTORS に入れないのは、あれが Qiita 側の DOM を指すものの置き場だから
 * （ハッシュクラス禁止の検査対象を、拡張自身の要素で薄めない）。
 */
export const NOTICE_ID = 'qtg-hidden-notice';

/**
 * 1 カードに含まれる記事リンクの数。これを超えたらカード境界を越えている。
 * 実測ではタイトル付きと無しの 2 本で、30 カード = 60 リンクだった。
 */
export const LINKS_PER_CARD = 2;

/** カードを探して祖先を遡る上限。無限ループの防止も兼ねる */
export const MAX_CARD_DEPTH = 6;

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
