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
import { DEFAULT_SETTINGS, isFoldTarget, isMuteOutcome } from '../types/domain';
import type {
  AccountHandle,
  AuthorVisits,
  Candidate,
  FeedbackLog,
  FoldTarget,
  LikeIndex,
  MuteLog,
  MuteOutcome,
  MuteRecord,
  ScanResult,
  Settings,
  Verdict,
} from '../types/domain';

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

/**
 * トークンが設定されているかだけを返す。
 * 表示にしか使わない画面へ生のトークンを渡さないための入口。
 */
export async function hasToken(): Promise<boolean> {
  return (await getToken()) !== null;
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

function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 判定の閾値。**sync に置く唯一のデータ**（PRD のストレージ設計）。
 * 共起インデックスは 10 MB 級になるので local 固定、これだけが sync。
 *
 * 【フィールド単位で検証する理由】
 * { minClusterSize: '5' } のような壊れ方を通すと findClusters の比較が
 * すべて false になり、候補が黙ってゼロになる。壊れた値ではなく既定値を返す。
 * 全体ではなく項目ごとに倒すのは、あとで項目を足したときに
 * 既存の 3 つまで巻き添えで失わないようにするため。
 */
export async function getSettings(): Promise<Settings> {
  const raw: unknown = await chrome.storage.sync.get('settings');
  const stored = (raw as { settings?: unknown } | null)?.settings;
  if (typeof stored !== 'object' || stored === null) return DEFAULT_SETTINGS;
  const candidate = stored as Partial<Record<keyof Settings, unknown>>;
  return {
    minClusterSize: asPositiveInt(candidate.minClusterSize) ?? DEFAULT_SETTINGS.minClusterSize,
    minSharedItems: asPositiveInt(candidate.minSharedItems) ?? DEFAULT_SETTINGS.minSharedItems,
    lookbackDays: asPositiveInt(candidate.lookbackDays) ?? DEFAULT_SETTINGS.lookbackDays,
    burstWindowMinutes:
      asPositiveInt(candidate.burstWindowMinutes) ?? DEFAULT_SETTINGS.burstWindowMinutes,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings });
}

/**
 * 著者ごとの判定。適合率の唯一の入力。
 *
 * 1 件だけ壊れていても全体を捨てない。評価はユーザーが積み上げた資産であり、
 * 候補と違って再計算で復元できない。
 */
export async function getFeedback(): Promise<FeedbackLog> {
  const raw = await readRaw();
  const stored = raw.feedback;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const log: FeedbackLog = {};
  // Object.entries(object) の値は any になる。unknown に落としてから絞ると、
  // 知らない値が FeedbackLog に紛れ込むのを型で止められる
  for (const [handle, value] of Object.entries(stored as Record<string, unknown>)) {
    if (value === 'valid' || value === 'false_positive') log[handle] = value;
  }
  return log;
}

/**
 * 判定を 1 件記録し、**書いた後の全体を返す。**
 *
 * 読んで足して書く。全件上書きにすると、ポップアップを 2 枚開いたときに
 * 互いの評価を消し合う。
 *
 * マージ結果を返すのは、呼び出し側が適合率を出すために読み直さずに済むため。
 * 捨てると 1 クリックあたり storage の往復が 3 回（読む・書く・また読む）になる。
 */
export async function saveVerdict(handle: AccountHandle, verdict: Verdict): Promise<FeedbackLog> {
  const feedback = { ...(await getFeedback()), [handle]: verdict };
  await chrome.storage.local.set({ feedback });
  return feedback;
}

/**
 * 「妥当」と同時に Qiita 側でもミュートするか。**既定は false。**
 *
 * 明示的にオンにしたときだけ Qiita 側を変更する。Settings（sync）に入れないのは、
 * あれが detectCandidates の入力だから — 判定に関係しない値を混ぜない。
 *
 * `=== true` で見ること。Boolean() だと 'false' という文字列が true になる。
 */
export async function getMuteOnValid(): Promise<boolean> {
  const raw = await readRaw();
  return raw.muteOnValid === true;
}

export async function saveMuteOnValid(muteOnValid: boolean): Promise<void> {
  await chrome.storage.local.set({ muteOnValid });
}

/**
 * 評価が済んだ候補を折りたたむ対象。**既定は 'none'（折りたたまない）。**
 *
 * local に置くのは muteOnValid と同じ理由 — Settings（sync）は
 * detectCandidates の入力であり、表示の設定を混ぜない。
 *
 * 知らない値は 'none' に倒す。通すと UI の switch が文言を返せずに落ちる
 * （getMuteLog が知らない outcome を落とすのと同じ）。
 */
export async function getFoldTarget(): Promise<FoldTarget> {
  const raw = await readRaw();
  return isFoldTarget(raw.foldTarget) ? raw.foldTarget : 'none';
}

export async function saveFoldTarget(foldTarget: FoldTarget): Promise<void> {
  await chrome.storage.local.set({ foldTarget });
}

/**
 * ミュートを試みた結果。1 件だけ壊れていても全体を捨てない
 * （getFeedback と同じ扱い）。
 *
 * **知らない outcome は落とす。**通すと UI の switch が文言を返せずに落ちる
 */
export async function getMuteLog(): Promise<MuteLog> {
  const raw = await readRaw();
  const stored = raw.muteLog;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const log: MuteLog = {};
  for (const [handle, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Partial<Record<keyof MuteRecord, unknown>>;
    const at = asNonEmptyString(record.at);
    if (at === null || !isMuteOutcome(record.outcome)) continue;
    const mutedAt = asNonEmptyString(record.mutedAt);
    log[handle] =
      mutedAt === null ? { outcome: record.outcome, at } : { outcome: record.outcome, at, mutedAt };
  }
  return log;
}

/**
 * 結果を 1 件記録し、**書いた後の全体を返す**（saveVerdict と同じ形）。
 * now を引数に取るのは、テストが時刻を固定できるようにするため。
 *
 * **mutedAt は消さない。**成功したという事実は、そのあと `not-on-page` に
 * なっても取り消されない（ミュートすると Qiita が記事をトレンドから外すので、
 * 押し直すと必ず `not-on-page` になる）。上書きすると UI が
 * 「まだミュートできていない」と誤って案内する。
 */
export async function recordMuteOutcome(
  handle: AccountHandle,
  outcome: MuteOutcome,
  now: Date,
): Promise<MuteLog> {
  const at = now.toISOString();
  const previous = await getMuteLog();
  const mutedAt = outcome === 'muted' ? at : previous[handle]?.mutedAt;
  const muteLog: MuteLog = {
    ...previous,
    [handle]: mutedAt === undefined ? { outcome, at } : { outcome, at, mutedAt },
  };
  await chrome.storage.local.set({ muteLog });
  return muteLog;
}

/**
 * 著者ごとの過去記事巡回の記録。フルモードだけが読み書きする。
 *
 * 1 件だけ壊れていても全体を捨てない（getFeedback と同じ扱い）。
 * 捨てると全著者が「未訪問」になり、次のスキャンで一斉に叩きに行く。
 */
export async function getAuthorVisits(): Promise<AuthorVisits> {
  const raw = await readRaw();
  const stored = raw.authorVisits;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const visits: AuthorVisits = {};
  for (const [handle, value] of Object.entries(stored as Record<string, unknown>)) {
    const at = asNonEmptyString(value);
    if (at !== null) visits[handle] = at;
  }
  return visits;
}

export async function saveAuthorVisits(authorVisits: AuthorVisits): Promise<void> {
  await chrome.storage.local.set({ authorVisits });
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
