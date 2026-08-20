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
import type { Candidate, IsoDateTime, LikeIndex, LocalState, ScanResult } from '../types/domain';

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

/** conditional GET と変化検知に使う前回値 */
export async function getFeedCache(): Promise<{
  etag: string | null;
  lastUpdated: IsoDateTime | null;
}> {
  const raw = await readRaw();
  return {
    etag: asNonEmptyString(raw.feedETag),
    lastUpdated: asNonEmptyString(raw.lastFeedUpdated),
  };
}

/**
 * フィードの取得結果を記録する。
 * 呼び出し側はスキャンが成功してから呼ぶこと。先に保存すると、
 * 途中で失敗したときに「取得済み」と誤認して次回スキャンがスキップされる。
 */
export async function saveFeedCache(etag: string | null, lastUpdated: IsoDateTime): Promise<void> {
  // exactOptionalPropertyTypes のため、値が無いキーは含めない
  const patch: Partial<LocalState> = { lastFeedUpdated: lastUpdated };
  if (etag !== null) patch.feedETag = etag;
  await chrome.storage.local.set(patch);
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
