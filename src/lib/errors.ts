/**
 * 本拡張が明示的に投げる例外。
 * DOM 取得の失敗には使わない（あちらは null を返すフェイルセーフ）。
 * ネットワーク層や設定値の不正など、呼び出し側が対処すべき失敗に使う。
 *
 * cause は Error のネイティブプロパティ（ES2022）をそのまま使う。
 * パラメータプロパティで再宣言すると noImplicitOverride と衝突する。
 */
export class QtgError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'QtgError';
  }
}

/**
 * レート枠を使い切ったことと、いつ再開できるかを表す。
 *
 * 【なぜ QtgError と区別するのか】
 * 429 は改訂 6 で「設計どおりの停止信号」になった。記事 1 件の失敗（読み飛ばして
 * 続行）と、枠切れ（そこで止める）は呼び出し側の対応が正反対であり、
 * message の文字列一致で見分けるのは脆い。
 *
 * 【なぜ qiita-client ではなくここに置くのか】
 * scanner.test.ts は qiita-client をモジュールごとモックする。エラー型が
 * クライアント側にあると、モックの戻り値が undefined になって instanceof が
 * 実行時に壊れる。例外型は例外の置き場に集める。
 */
export class RateLimitError extends QtgError {
  /** Unix 秒。Rate-Reset ヘッダーが無ければ null */
  readonly resetAt: number | null;

  constructor(resetAt: number | null) {
    super('api rate limit exceeded');
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}
