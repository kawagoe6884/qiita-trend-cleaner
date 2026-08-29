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
  /**
   * カードの三点メニューを開くボタン（アイコンは more_horiz）。
   * aria-haspopup と aria-label はどちらも ARIA の契約であり、CSS-in-JS の
   * ハッシュクラスと違ってリニューアルに耐える。
   *
   * ⚠️ aria-controls が <ul role="menu"> の id を指すが、**開いたあとに読むこと**。
   *    React は開いたときに初めて属性を設定することがある。
   */
  cardMenuButton: '[aria-haspopup="dialog"][aria-label="ユーザーを管理"]',
  /** 開いたメニュー本体。aria-controls の id と突き合わせて特定する */
  cardMenu: '[role="menu"]',
  /** メニューの項目。**どれを押すかはテキストだけで決める**（MENU_TEXT 参照） */
  menuItem: '[role="menuitem"]',
  /**
   * 項目の中で実際に押す要素。
   *
   * ⚠️ **`[role="menuitem"]` は器で、ハンドラは中の `<button>` にある**（2026-08-24 実測）。
   * イベントは下へ伝播しないので、`<li>` を押しても何も起きない。実測の形:
   * `<li role="menuitem"><button type="button"><span aria-hidden>icon</span>ラベル</button></li>`
   *
   * どの項目かは器のテキストで決め、押すのはその中身。**器の外には出ない**ので、
   * 隣の項目（ブロック）を踏むことは起きない。
   */
  menuItemAction: 'button',
} as const;

/** Snackbar が表示する完了メッセージ。Phase 8 の完了検知に使う */
export const SNACKBAR_TEXT = {
  muteCompleted: 'ミュートが完了しました',
  unmuteCompleted: 'ミュートの解除が完了しました',
} as const;

/**
 * メニュー項目の文言。**完全一致でのみ使う。**
 *
 * ⚠️ ブロックがミュートの **直上** にある（2026-08-24 実測）。順序やインデックスで
 * 選ぶと 1 つずれただけでブロックを踏む。ブロックは native alert() を起動して
 * content script から閉じられず、解除用の一覧 URL も存在しないので誤検知を
 * 回収できない（設計上の約束 7）。
 * **block は「押してはいけないもの」としてだけ持つ。**テストが誤爆を検査するために使う。
 *
 * 【unmute を持つことにした】（2026-08-29・方針転換。実測値はユーザー提供）
 * 項目はトグルで、ミュート中は解除側の文言に変わる。以前は「知らない方が安全」
 * として持たなかったが、その結果**既にミュート済みと画面構造の変化が区別できず**、
 * UI が推測を並べるしかなかった。**読むためだけに持てば、推測が事実になる。**
 *
 * ⚠️ **unmute も block と同じ「押してはいけないもの」。**分類にのみ使い、
 * `click()` には決して渡さない。押す経路は `muter.ts` の `findMuteItem` 1 本で、
 * そこは `endsWith(mute)` のままなので unmute には一致しない
 * （「投稿ユーザーのミュートを解除」は「投稿ユーザーをミュート」で終わらない）。
 * この相互排他は selectors.test.ts と muter.test.ts が機械的に検査する。
 *
 * **ユーザーページの文言（「ミュートする」「ミュートを解除する」）は持たない。**
 * 拡張はユーザーページを開かないうえ、**両ページの文言が一文字も重ならないこと
 * 自体が、誤ってユーザーページの DOM を掴んでも何も押さない保証**になっている。
 */
export const MENU_TEXT = {
  mute: '投稿ユーザーをミュート',
  block: '投稿ユーザーをブロック',
  unmute: '投稿ユーザーのミュートを解除',
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
 * 「妥当」と判断された著者のカードに付ける目印（dataset のキー名）。
 *
 * **`HIDDEN_MARKER` と分けるのは、「表示する」で戻したときに残すため。**
 * 隠れているかどうか（qtgHidden）と、妥当と判断されたかどうか（qtgJudged）は
 * 別の情報で、前者だけが「表示する」で消える。色が残るので、戻したときに
 * どのカードが該当なのかが分かり、誤検知の確認ができる。
 */
export const HIGHLIGHT_MARKER = 'qtgJudged';

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
