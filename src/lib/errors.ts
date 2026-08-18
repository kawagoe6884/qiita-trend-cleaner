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
