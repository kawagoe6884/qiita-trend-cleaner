/**
 * トークン設定 UI の状態遷移とメッセージ決定。
 *
 * 【DOM を参照しない理由】
 * document を触るのは main.ts の責務にする。selectors.ts で DOM の知識を
 * 1 ファイルに隔離したのと同じ思想で、「401 では保存しない」のような
 * 重要な性質をユニットテストで固定できるようにする。
 *
 * 【状態が常に実際のモードを表す理由】
 * 以前は失敗を独立した 'error' 状態で表していたが、保存済みトークンがある人が
 * 差し替えに失敗すると、storage には古いトークンが残っているのに画面だけ
 * 「ライトモードで動作中」に変わり、削除ボタンも消えていた。
 * scanner は storage を読んでフルモードで動き続けるため、UI が実際と逆のことを
 * 主張することになる。**失敗はメッセージであって状態ではない**ため、
 * kind は保存状態だけを表し、メッセージは付随情報として持たせる。
 *
 * 【トークンの扱い】
 * 生のトークンは状態に載せない。画面へ戻すのはマスク済みの文字列だけ。
 * logger にも渡さない（コードベース全体で 0 件を維持する）。
 */
import { verifyToken } from '../../api/qiita-client';
import * as storage from '../../lib/storage';
import { RATE_LIMIT_ANON, RATE_LIMIT_AUTH } from '../../api/rate-budget';

/**
 * 保存状態が確定している状態。kind は storage の実態と必ず一致する。
 * message は「直前の操作の結果」であって、モードを変えるものではない。
 */
export type SettledState =
  | { kind: 'light'; message?: string }
  | { kind: 'full'; masked: string; message?: string };

/** 画面が取りうる状態。verifying は過渡状態で保存状態を表さない */
export type TokenState = SettledState | { kind: 'verifying' };

/** モード表示の文言 */
export interface ModeCopy {
  title: string;
  detail: string;
}

/** マスクで残す前後の文字数 */
const VISIBLE_CHARS = 4;
/** これ以下の長さなら全マスクする（短いトークンで中身が露出しないように） */
const FULL_MASK_THRESHOLD = 12;
/** 中央のマスク記号の数。実際の長さを推測させないため固定にする */
const MASK_WIDTH = 8;

/** 画面表示用にトークンを伏せる。元の値を復元できない形にする */
export function maskToken(token: string): string {
  if (token.length <= FULL_MASK_THRESHOLD) return '•'.repeat(token.length);
  return token.slice(0, VISIBLE_CHARS) + '•'.repeat(MASK_WIDTH) + token.slice(-VISIBLE_CHARS);
}

/** 保存状態は変えずにメッセージだけ載せる */
function withMessage(state: SettledState, message: string): SettledState {
  return { ...state, message };
}

/**
 * 状態からモード表示の文言を作る。
 * レート枠の数値は rate-budget の定数から作り、UI に直書きしない。
 */
export function describeMode(state: TokenState): ModeCopy {
  if (state.kind === 'full') {
    return {
      title: 'フルモードで動作中',
      detail: `トレンド 30 件に加えて、著者の過去記事まで辿ります。1 時間あたり ${String(RATE_LIMIT_AUTH)} リクエストまで使えます。`,
    };
  }
  if (state.kind === 'verifying') {
    return { title: '確認中', detail: 'トークンが使えるか Qiita に問い合わせています。' };
  }
  return {
    title: 'ライトモードで動作中',
    detail: `トレンド 30 件の範囲で検出します。1 時間あたり ${String(RATE_LIMIT_ANON)} リクエストまで。`,
  };
}

/** 保存済みの状態を読む。表示される kind は必ず storage の実態と一致する */
export async function loadState(): Promise<SettledState> {
  const token = await storage.getToken();
  return token === null ? { kind: 'light' } : { kind: 'full', masked: maskToken(token) };
}

/**
 * 入力されたトークンを検証して保存する。
 * 検証に失敗したものは保存せず、**保存済みの状態をそのまま返す**。
 */
export async function submitToken(raw: string): Promise<SettledState> {
  // コピペで前後に空白や改行が混ざるのが最も多い失敗
  const token = raw.trim();
  if (token.length === 0) {
    return withMessage(await loadState(), 'トークンを入力してください。');
  }

  const result = await verifyToken(token);
  if (!result.ok) {
    // 保存済みトークンがあれば実際はフルモードのまま。storage を読み直して
    // 実態に合わせた状態を返し、その上にメッセージだけ載せる
    return withMessage(
      await loadState(),
      result.reason === 'invalid'
        ? 'トークンが受け付けられませんでした。値と、read_qiita スコープが付いているかを確認してください。'
        : 'Qiita に接続できませんでした。通信状況を確認して、もう一度お試しください。',
    );
  }

  await storage.saveToken(token);
  return { kind: 'full', masked: maskToken(token) };
}

/** 保存済みトークンを削除してライトモードに戻す */
export async function removeToken(): Promise<SettledState> {
  await storage.clearToken();
  return { kind: 'light' };
}
