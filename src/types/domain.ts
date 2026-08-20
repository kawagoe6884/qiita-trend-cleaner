/** ISO 8601 (JST オフセット付き) の日時文字列。例: "2026-08-18T17:00:00+09:00" */
export type IsoDateTime = string;

/** Qiita のユーザーハンドル（API の User.id） */
export type AccountHandle = string;

/** Qiita の記事 ID */
export type ItemId = string;

/**
 * トレンドページに出ている記事 1 件。
 * 表示中の DOM から読む（src/dom/trend-reader.ts）。HTML の fetch はしない。
 */
export interface TrendItem {
  itemId: ItemId;
  url: string;
  authorHandle: AccountHandle;
  publishedAt: IsoDateTime;
}

/** あるアカウントによる 1 件のいいね */
export interface LikeRecord {
  itemId: ItemId;
  authorHandle: AccountHandle;
  /** Like.created_at */
  likedAt: IsoDateTime;
  /** バースト判定用。記事の投稿時刻 */
  itemPostedAt: IsoDateTime;
}

/**
 * アカウント単位の逆引きインデックス。
 * Qiita API には「ユーザーがいいねした記事一覧」が存在しないため、
 * 記事 -> likers の方向で取得した結果をここに畳み込む。
 */
export interface AccountIndexEntry {
  likes: LikeRecord[];
  /** User.items_count */
  itemsCount: number;
  /** User.followers_count */
  followersCount: number;
  /** User.description !== null */
  hasDescription: boolean;
}

export type LikeIndex = Record<AccountHandle, AccountIndexEntry>;

/** 候補に対するユーザーの判定。適合率の計算に使う */
export type Verdict = 'valid' | 'false_positive';

/** 検出された組織票の候補 */
export interface Candidate {
  authorHandle: AccountHandle;
  clusterAccounts: AccountHandle[];
  /**
   * M: クラスタが N 人そろって現れた記事の数。
   * 「誰か 1 人でもいいねした記事の数」ではない。
   * 同じ顔ぶれが揃っていることが組織票の signature であり、
   * バラバラの共起を数えると誤検知の入口になる（detect/cluster.ts の手順 4）。
   */
  sharedItemCount: number;
  /** 根拠として提示する記事。Phase 6 の一覧で「なぜ」を示すために持つ */
  sharedItemIds: ItemId[];
  /** N: クラスタを構成するアカウント数 */
  clusterSize: number;
  /** 0.0-1.0。投稿直後に集中したいいねの割合 */
  burstScore: number;
  /** 0.0-1.0。クラスタのうち記事 0 本・プロフィール空のアカウントの割合 */
  emptyAccountRatio: number;
  detectedAt: IsoDateTime;
  verdict: Verdict | null;
}

/** storage.sync に置く設定。アクセストークンは含めない */
export interface Settings {
  minClusterSize: number;
  minSharedItems: number;
  lookbackDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  minClusterSize: 5,
  minSharedItems: 2,
  lookbackDays: 3,
};

/** 取得の射程。トークンの有無ではなくレート枠から決まる */
export type ScanMode = 'light' | 'full';

/** スキャン 1 回の結果サマリ。ログと Phase 6 の表示に使う */
export interface ScanResult {
  mode: ScanMode;
  /** 蓄積に無く、今回取得を試みた記事の数 */
  newItemCount: number;
  /** 実際に likers を取得できた記事の数 */
  scannedItemCount: number;
  likeRecordCount: number;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime;
}

/**
 * storage.local のスキーマ全体。
 * token は sync に置かない（同期による漏出面の拡大を避けるため）。
 */
export interface LocalState {
  token?: string;
  /**
   * 429 に達したときの再開時刻。**Unix 秒**（Rate-Reset の単位）。
   * ミリ秒ではない。Phase 6 がバッジとポップアップで「あと N 分」を出す
   */
  rateLimitedUntil?: number;
  likeIndex: LikeIndex;
  candidates: Candidate[];
  /** 保持期間 7 日 */
  purgeAfter?: IsoDateTime;
  /** 最後にスキャンした時刻 */
  lastScanAt?: IsoDateTime;
  /** 最後のスキャン結果 */
  lastScanResult?: ScanResult;
}
