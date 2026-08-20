/**
 * chrome.storage.local への型付きアクセスの唯一の窓口。
 * キー名を文字列で直接触らせないことで、スキーマ変更を 1 ファイルに閉じ込める。
 *
 * 【キャッシュを持たない理由】
 * service worker は idle で終了し、モジュールスコープの変数はそのとき消える。
 * 「起動しっぱなし」を前提にしたキャッシュは黙って古い値を返す原因になるため、
 * 呼ばれるたびに storage を読む。
 *
 * 【検証の程度】
 * ここが読むのは自分で書いた値なので、API レスポンスほど厳密には検証しない。
 * ただし storage が壊れていても例外で落とさず、既定値へフォールバックする。
 */
import type { Candidate, LikeIndex, ScanResult } from '../types/domain';

/** storage が空のときに使う値 */
const DEFAULT_LIKE_INDEX: LikeIndex = {};

async function readRaw(): Promise<Record<string, unknown>> {
  const raw: unknown = await chrome.storage.local.get(null);
  if (typeof raw !== 'object' || raw === null) return {};
  return raw as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * アクセストークンを読む。未設定なら null。
 * トークンは任意設定であり、無い場合はライトモードで動作する。
 */
export async function getToken(): Promise<string | null> {
  const raw = await readRaw();
  return asNonEmptyString(raw.token);
}

export async function saveToken(token: string): Promise<void> {
  await chrome.storage.local.set({ token });
}

export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove('token');
}

/**
 * 429 に達したことの記録。**Unix 秒**（Rate-Reset の単位）。ミリ秒ではない。
 * Phase 6 がバッジとポップアップで「あと N 分」を出すために読む。
 */
export async function getRateLimitedUntil(): Promise<number | null> {
  const raw = await readRaw();
  const value = raw.rateLimitedUntil;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 再開時刻を記録する。null を渡すとキーごと消える。
 *
 * 枠が回復したかどうかを保存側で判断しない。429 を受けたら書き、
 * スキャンが 429 なしで終わったら消す。「いま止まっているか」だけを表す。
 */
export async function saveRateLimit(resetAt: number | null): Promise<void> {
  if (resetAt === null) {
    await chrome.storage.local.remove('rateLimitedUntil');
    return;
  }
  await chrome.storage.local.set({ rateLimitedUntil: resetAt });
}

export async function getLikeIndex(): Promise<LikeIndex> {
  const raw = await readRaw();
  const index = raw.likeIndex;
  if (typeof index !== 'object' || index === null || Array.isArray(index)) {
    return DEFAULT_LIKE_INDEX;
  }
  return index as LikeIndex;
}

export async function saveLikeIndex(likeIndex: LikeIndex): Promise<void> {
  await chrome.storage.local.set({ likeIndex });
}

/**
 * 検出された候補。Phase 6 の一覧 UI の入力になる。
 * getLikeIndex は「配列なら壊れている」と判定するが、こちらは配列が正しい形。
 */
export async function getCandidates(): Promise<Candidate[]> {
  const raw = await readRaw();
  const list = raw.candidates;
  if (!Array.isArray(list)) return [];
  return list as Candidate[];
}

export async function saveCandidates(candidates: Candidate[]): Promise<void> {
  await chrome.storage.local.set({ candidates });
}

export async function saveScanResult(result: ScanResult): Promise<void> {
  await chrome.storage.local.set({ lastScanAt: result.finishedAt, lastScanResult: result });
}

export async function getLastScanResult(): Promise<ScanResult | null> {
  const raw = await readRaw();
  const result = raw.lastScanResult;
  if (typeof result !== 'object' || result === null) return null;
  return result as ScanResult;
}
