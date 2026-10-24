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
import {
  AI_HINT_MIN_PROSE_RANGE,
  AI_HINT_SCORE_RANGE,
  AI_HINT_THRESHOLD_RANGE,
  AI_SIGNALS,
  DEFAULT_AI_HINT_PREFS,
  DEFAULT_SETTINGS,
  isAiSignal,
  isFoldTarget,
  isIntInRange,
  isMuteOutcome,
} from '../types/domain';
import type {
  AccountHandle,
  AiAnswer,
  AiHint,
  AiHintPrefs,
  AiHintLog,
  AiSignal,
  AiVerdict,
  AiVerdictLog,
  ItemId,
  AuthorVisits,
  Candidate,
  FeedbackLog,
  FoldTarget,
  IsoDateTime,
  LikeIndex,
  LocalState,
  MuteLog,
  MuteOutcome,
  MuteRecord,
  ScanResult,
  Settings,
  TrendSnapshot,
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
 * 「AI文体かも？」の線引き。**既定は 5 点 / 334 字。**
 *
 * local に置くのは foldTarget と同じ理由 — Settings（sync）は
 * detectCandidates の入力であり、表示の設定を混ぜない。
 *
 * 項目ごとに検証し、壊れた項目だけ既定値に倒す（もう片方は生かす）。
 */
export async function getAiHintPrefs(): Promise<AiHintPrefs> {
  const raw = await readRaw();
  const stored = raw.aiHintPrefs;
  if (typeof stored !== 'object' || stored === null) return { ...DEFAULT_AI_HINT_PREFS };
  const { threshold, minProseChars } = stored as Record<string, unknown>;
  return {
    threshold: isIntInRange(threshold, AI_HINT_THRESHOLD_RANGE)
      ? threshold
      : DEFAULT_AI_HINT_PREFS.threshold,
    minProseChars: isIntInRange(minProseChars, AI_HINT_MIN_PROSE_RANGE)
      ? minProseChars
      : DEFAULT_AI_HINT_PREFS.minProseChars,
  };
}

export async function saveAiHintPrefs(aiHintPrefs: AiHintPrefs): Promise<void> {
  await chrome.storage.local.set({ aiHintPrefs });
}

/**
 * ミュートを試みた結果（トレンド外で見送った記録も含む）。1 件だけ壊れていても全体を捨てない
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
 * **ここでは mutedAt を消さない。**試行の結果だけでは解除を知りようがないため。
 * 押し直したときに返るのは、**ページを読み込み直す前なら** `already-muted`
 * （カードが DOM に残っている）、**読み込み直したあとなら** `not-on-page`
 * （記事ごとトレンドから消える）で、どちらも「解除されたか」を区別できない。
 * 上書きすると UI が「まだミュートできていない」と誤って案内する。
 *
 * **消すのは `forgetMuteConfirmation` だけ。**解除の証拠はここではなく、
 * トレンドに著者が戻ってきたという事実の側から来る。
 *
 * **`already-muted` でも mutedAt を立てる。**押してはいないが、メニューの文言が
 * 解除側だったのだから**その時点でミュート中だと確認できている**。
 * `mutedAt` は「いつ押したか」ではなく「**いつミュート中だと確認できたか**」。
 */
export async function recordMuteOutcome(
  handle: AccountHandle,
  outcome: MuteOutcome,
  now: Date,
): Promise<MuteLog> {
  const at = now.toISOString();
  const previous = await getMuteLog();
  const confirmed = outcome === 'muted' || outcome === 'already-muted';
  const mutedAt = confirmed ? at : previous[handle]?.mutedAt;
  const muteLog: MuteLog = {
    ...previous,
    [handle]: mutedAt === undefined ? { outcome, at } : { outcome, at, mutedAt },
  };
  await chrome.storage.local.set({ muteLog });
  return muteLog;
}

/**
 * トレンドに戻ってきた著者の「ミュート済み」の記録を捨て、**書いた後の全体を返す**。
 *
 * 【なぜこれが解除の証拠になるのか】
 * ミュート済みの著者の記事は、**新規ロードのトレンドには載らない**（2026-09-16 実測。
 * 押した直後の DOM には残るが、更新すると消える）。だから {@link TrendSnapshot} に
 * 居る著者は、その時点でミュートされていない。
 *
 * 【`snapshotAt` で必ず絞る】
 * `TREND_ITEMS` はページ読み込み時のスナップショットで、service worker が処理する
 * 頃にはユーザーが既にミュートを押しているかもしれない。**確認より前に撮られた
 * スナップショットは証拠にならない**ので、`mutedAt < snapshotAt` のときだけ捨てる。
 *
 * 【記録ごと捨てる理由】
 * `mutedAt` だけ消すと `outcome: 'muted'` が残り、UI が
 * 「Qiita 側でミュートしました。」と言い続ける。いま押せる状態に戻ったのだから、
 * **一度も試していないのと同じ**に戻すのが正しい。
 *
 * 【読めない時刻は捨てない】
 * 証拠が読めないときは、古い記録を残す側に倒す。消しすぎると
 * ミュート済みの著者に「ミュートする」を出すことになる。
 *
 * 【ポップアップの `recordMuteOutcome` と同じ muteLog を触る】
 * 読み直してから書くまでを 1 マイクロタスクに収める（`persistIndexAndDetect`
 * と同じ扱い）。スナップショットの保存を**先に**済ませてあるのは、その await を
 * この窓の外に出すため。
 */
export async function forgetMuteConfirmation(
  handles: readonly AccountHandle[],
  snapshotAt: IsoDateTime,
): Promise<MuteLog> {
  const previous = await getMuteLog();
  const seenAt = Date.parse(snapshotAt);
  if (Number.isNaN(seenAt)) return previous;
  const returned = new Set(handles);
  const kept = Object.entries(previous).filter(([handle, record]) => {
    if (!returned.has(handle) || record.mutedAt === undefined) return true;
    const confirmedAt = Date.parse(record.mutedAt);
    if (Number.isNaN(confirmedAt)) return true;
    return confirmedAt >= seenAt;
  });
  if (kept.length === Object.keys(previous).length) return previous;
  const muteLog: MuteLog = Object.fromEntries(kept);
  await chrome.storage.local.set({ muteLog });
  return muteLog;
}

/**
 * 直近に新規ロードしたトレンドページの著者一覧。撮っていなければ null。
 *
 * **null と空配列を取り違えない。**「まだ一度もトレンドを開いていない」と
 * 「開いたが 1 件も読めなかった」は別物で、前者では候補に
 * 「トレンドに出ていません」と言ってはいけない（分母 0 を 0% にしないのと同じ話）。
 */
export async function getTrendSnapshot(): Promise<TrendSnapshot | null> {
  const raw = await readRaw();
  const stored = raw.trendSnapshot;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;
  const candidate = stored as Partial<Record<keyof TrendSnapshot, unknown>>;
  const at = asNonEmptyString(candidate.at);
  if (at === null || !Array.isArray(candidate.authors)) return null;
  const authors = candidate.authors.filter(
    (value): value is AccountHandle => asNonEmptyString(value) !== null,
  );
  return { authors, at };
}

/** 著者は重複を落として保存する。1 人が複数記事を出していても 1 回だけ */
export async function saveTrendSnapshot(
  handles: readonly AccountHandle[],
  now: Date,
): Promise<TrendSnapshot> {
  const trendSnapshot: TrendSnapshot = {
    authors: [...new Set(handles)].sort(),
    at: now.toISOString(),
  };
  await chrome.storage.local.set({ trendSnapshot });
  return trendSnapshot;
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

/** 1 件分の文体スコアを検証する。知らないシグナルは捨て、形が崩れていれば null */
function asAiHint(value: unknown): AiHint | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<Record<keyof AiHint, unknown>>;
  const scoredAt = asNonEmptyString(candidate.scoredAt);
  const { proseChars, fired } = candidate;
  if (scoredAt === null || !Array.isArray(fired)) return null;
  if (typeof proseChars !== 'number' || !Number.isInteger(proseChars) || proseChars < 0) {
    return null;
  }
  return { fired: fired.filter(isAiSignal), proseChars, scoredAt };
}

/**
 * 記事ごとの文体スコア。フルモードだけが書く。
 *
 * 1 件だけ壊れていても全体を捨てない（getAuthorVisits と同じ扱い）。
 * 捨てると全記事が「未スコア」になり、次のスキャンで本文を一斉に取りに行く。
 */
export async function getAiHints(): Promise<AiHintLog> {
  const raw = await readRaw();
  const stored = raw.aiHints;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const hints: AiHintLog = {};
  for (const [itemId, value] of Object.entries(stored as Record<string, unknown>)) {
    const hint = asAiHint(value);
    if (hint !== null) hints[itemId] = hint;
  }
  return hints;
}

/** パージ済みの全体を書く。マージとパージは呼び出し側（scanner）が保存の直前に行う */
export async function saveAiHints(aiHints: AiHintLog): Promise<void> {
  await chrome.storage.local.set({ aiHints });
}

function isAiVerdict(value: unknown): value is AiVerdict {
  return value === 'yes' || value === 'no';
}

/**
 * 1 件分の回答を検証する。形が崩れていれば null。
 *
 * **M3 より前の旧形式（`'yes' | 'no'` だけ）も読む。**点数が残っていないので
 * score / fired / answeredAt は null にする。消すと利用者が積み上げた回答が失われる。
 *
 * fired（立っていたシグナル）が無いのは、それを残す前の回答。null として読む
 * （一致率には点数だけで入る）。知らないシグナルは捨てる。
 */
/**
 * 回答時に立っていたシグナルを読む。配列でなければ null（残す前の回答）。
 *
 * 知らないシグナルを捨て、**重複を 1 つにし、AI_SIGNALS の順に並べ直す。**
 * 壊れたデータで重複があると、指標ごとの分析で件数がずれる。
 * 点数（score）は書き換えない — 一致率は点数を正とする
 */
function asFiredSignals(value: unknown): AiSignal[] | null {
  if (!Array.isArray(value)) return null;
  const raised = new Set(value.filter(isAiSignal));
  return AI_SIGNALS.filter((signal) => raised.has(signal));
}

function asAiAnswer(value: unknown): AiAnswer | null {
  if (isAiVerdict(value)) return { verdict: value, score: null, fired: null, answeredAt: null };
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<Record<keyof AiAnswer, unknown>>;
  const { verdict, score, answeredAt } = candidate;
  if (!isAiVerdict(verdict)) return null;
  if (score === null && answeredAt === null) {
    return { verdict, score, fired: null, answeredAt };
  }
  const at = asNonEmptyString(answeredAt);
  // 点数はシグナルの数（0〜8）を超えない。範囲外を通すと一致率の計算に紛れ込む
  if (at === null || !isIntInRange(score, AI_HINT_SCORE_RANGE)) return null;
  return { verdict, score, fired: asFiredSignals(candidate.fired), answeredAt: at };
}

/** 「AI文体かも？」への回答。1 件だけ壊れていても全体を捨てない（getFeedback と同じ扱い） */
export async function getAiVerdicts(): Promise<AiVerdictLog> {
  const raw = await readRaw();
  const stored = raw.aiVerdicts;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const log: AiVerdictLog = {};
  for (const [itemId, value] of Object.entries(stored as Record<string, unknown>)) {
    const answer = asAiAnswer(value);
    if (answer !== null) log[itemId] = answer;
  }
  return log;
}

/**
 * 回答を 1 件記録し、**書いた後の全体を返す。**
 *
 * 読んで足して書く（saveVerdict と同じ理由 — トレンドのタブを 2 枚開いて
 * 互いの回答を消し合わない）。
 */
export async function saveAiVerdict(itemId: ItemId, answer: AiAnswer): Promise<AiVerdictLog> {
  const aiVerdicts = { ...(await getAiVerdicts()), [itemId]: answer };
  await chrome.storage.local.set({ aiVerdicts });
  return aiVerdicts;
}

/**
 * 回答を 1 件取り消し、**消した後の全体を返す。**回答済みの側をもう一度押したとき（M3）。
 * 読んで消して書く（saveAiVerdict と同じ理由）
 */
export async function removeAiVerdict(itemId: ItemId): Promise<AiVerdictLog> {
  const aiVerdicts = Object.fromEntries(
    Object.entries(await getAiVerdicts()).filter(([key]) => key !== itemId),
  );
  await chrome.storage.local.set({ aiVerdicts });
  return aiVerdicts;
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

/**
 * storage.local を**まるごと**置き換える。**fixture ビルドの起動時にだけ使う**
 * （`background/fixture-seed.ts`）。
 *
 * 【なぜ消してから書くのか】
 * 撮り直すたびに同じ画面にしたい。前回の撮影で押した「妥当」やミュートの記録が
 * 残ると、同じ fixture から別の画面ができてしまう。
 *
 * 【消してよい理由】
 * fixture ビルドは `dist-fixture/` に出力するので、Chrome 上では本番とは
 * **別の拡張（別の ID・別の storage）**として読み込まれる（vite.config.ts）。
 * ここで消えるのは fixture 用の拡張の storage だけで、本番の蓄積や評価には届かない。
 *
 * 【本番ビルドでは何もしない】
 * 呼ぶのは fixture ビルドの分岐の中だけだが、それでも本番の `dist/` にこの関数が
 * 残っていた（2026-09-28 実測。到達しない import でもバンドラが export を残す —
 * `detect/fixture.ts` の FIXTURE_SCENE の JSDoc）。**ユーザーの蓄積と評価を
 * 全部消す関数を配布物に入れない。**ここで mode を見れば、本番では本体ごと畳まれ、
 * 万一呼ばれても消さない。
 */
export async function resetLocalState(state: Partial<LocalState>): Promise<void> {
  if (import.meta.env.MODE !== 'fixture') return;
  await chrome.storage.local.clear();
  await chrome.storage.local.set(state);
}
