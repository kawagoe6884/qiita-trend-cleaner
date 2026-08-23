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

/**
 * 著者ハンドル -> 判定。
 *
 * **Candidate の中に持たない。** 閾値を動かすと detectCandidates が候補を
 * 作り直すため、そこに置くとスライダーを 1 つ動かした瞬間に評価が全部消える。
 * 適合率は評価の蓄積そのものなので、それは指標の破壊にあたる。
 *
 * キーを著者だけにするのは、根拠記事の集合は閾値で変わるが
 * 「この著者は妥当か」というユーザーの判断は変わらないため。
 */
export type FeedbackLog = Record<AccountHandle, Verdict>;

/**
 * 著者ハンドル -> 最後に過去記事を辿った時刻（フルモードのみ）。
 *
 * **「その著者を一度でも訪れたか」は記事 ID からは判定できない。**
 * 記事が 1 本しか無い著者と、まだ辿っていない著者が同じ見え方になるため。
 * これを持たずに「新しい記事の著者だけ辿る」形にしていた結果、
 * ライトモードで蓄積したあとにトークンを設定した人は、その著者の過去記事を
 * **永久に取りに行かなかった**（2026-08-23 の実機で判明）。
 */
export type AuthorVisits = Record<AccountHandle, IsoDateTime>;

/** 検出された組織票の候補 */
export interface Candidate {
  authorHandle: AccountHandle;
  clusterAccounts: AccountHandle[];
  /**
   * M: クラスタが N 人そろって現れた記事の数。
   * 「誰か 1 人でもいいねした記事の数」ではない。
   * 同じ顔ぶれが揃っていることが組織票の signature であり、
   * バラバラの共起を数えると誤検知の入口になる（detect/cluster.ts の手順 4）。
   *
   * **著者をまたぐ共起では 1 になりうる。** そちらは「別々の著者の記事に
   * 同じ顔ぶれが揃う」判定なので、記事の本数はクラスタ全体で満たせばよく、
   * 著者ごとには課さない（detect/cross-cluster.ts）。記事 1 本の著者を
   * 捕まえるための判定なので、この非対称は意図的なもの。
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
  /**
   * 同じクラスタが現れた他の著者。**著者をまたぐ共起のときだけ入る。**
   *
   * 根拠記事（sharedItemIds）はこの著者のぶんしか持たない — popup-state.ts が
   * 根拠 URL を authorHandle から組み立てるため、他著者の記事 ID を混ぜると
   * 誤った記事を表示してしまう。UI はここを見て「他にも居る」ことを示す。
   */
  coAuthors?: AccountHandle[];
}

/** storage.sync に置く設定。アクセストークンは含めない */
export interface Settings {
  minClusterSize: number;
  minSharedItems: number;
  lookbackDays: number;
}

/**
 * 既定値は **フルモード前提**（改訂 6 以降）。
 *
 * `lookbackDays` は 3 日だった。だがフルモードが辿る過去記事は定義上「過去」で、
 * 3 日ではほぼ確実に窓の外に出る。**89 件のいいねを取得して判定に 0 件しか
 * 使っていなかった**（2026-08-23 実測）。`RETENTION_DAYS` と同値の 7 にして、
 * 取ったものを捨てないようにする。
 *
 * **保存済みの設定は変えない。** `getSettings` は保存値を優先するので、
 * これは新規インストール時の値でしかない。
 */
export const DEFAULT_SETTINGS: Settings = {
  minClusterSize: 5,
  minSharedItems: 2,
  lookbackDays: 7,
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
  /** 候補への判定。適合率の唯一の入力 */
  feedback?: FeedbackLog;
  /** 著者ごとの過去記事巡回の記録。保持期間 7 日でパージする */
  authorVisits?: AuthorVisits;
  /** 保持期間 7 日 */
  purgeAfter?: IsoDateTime;
  /** 最後にスキャンした時刻 */
  lastScanAt?: IsoDateTime;
  /** 最後のスキャン結果 */
  lastScanResult?: ScanResult;
}
