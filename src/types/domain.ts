/** ISO 8601 (JST オフセット付き) の日時文字列。例: "2026-08-18T17:00:00+09:00" */
export type IsoDateTime = string;

/** Qiita のユーザーハンドル（API の User.id） */
export type AccountHandle = string;

/** Qiita の記事 ID */
export type ItemId = string;

/** Atom フィードの 1 エントリ */
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
  /** M: 共通していいねされた記事数 */
  sharedItemCount: number;
  /** N: クラスタを構成するアカウント数 */
  clusterSize: number;
  /** 0.0-1.0 */
  burstScore: number;
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

/**
 * storage.local のスキーマ全体。
 * token は sync に置かない（同期による漏出面の拡大を避けるため）。
 */
export interface LocalState {
  token?: string;
  /** Atom feed ルートの <updated>。変化検知でスキャンを起動する */
  lastFeedUpdated?: IsoDateTime;
  /** conditional GET 用 */
  feedETag?: string;
  likeIndex: LikeIndex;
  candidates: Candidate[];
  /** 保持期間 7 日 */
  purgeAfter?: IsoDateTime;
}
