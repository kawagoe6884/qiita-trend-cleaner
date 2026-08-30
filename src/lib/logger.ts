/**
 * ログの唯一の出口。console を直接呼ばず、必ずここを通す。
 * ESLint の no-console は本ファイルのみ例外にしている。
 */
const PREFIX = '[QTG]';

export const logger = {
  debug: (...args: unknown[]): void => console.debug(PREFIX, ...args),
  info: (...args: unknown[]): void => console.info(PREFIX, ...args),
  warn: (...args: unknown[]): void => console.warn(PREFIX, ...args),
  error: (...args: unknown[]): void => console.error(PREFIX, ...args),
};
