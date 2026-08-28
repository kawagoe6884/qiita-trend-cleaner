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
  /**
   * その記事の**総**いいね数（取得時の `Total-Count` ヘッダー）。
   *
   * **窓内占有率の分母が信用できるかを判定するためだけに持つ。**
   * インデックスが持つ liker 数がこれに満たなければ取りこぼしており、
   * 占有率は計算できない。`page=1` は**降順**なので「最も新しい 100 件」であり、
   * 100 いいねを超える記事では投稿直後のいいねが 1 件も入らない（2026-08-25 実測）。
   *
   * **任意。**ヘッダーが欠ければ undefined になり「不明」として扱われる。
   * 記事ごとの値をレコードに複製しているのは、別の storage キーにすると
   * purge と merge を二重に書くことになるため（ここなら自動的に正しい）。
   */
  itemTotalLikes?: number;
  /**
   * この記事について、**投稿から何分後までのいいねを全部持っているか**。
   *
   * likes は降順（新しい順）で返るので、100 件を超える記事では末尾ページから
   * 遡って取る。その結果インデックスは「古い側は完全・真ん中が欠け・新しい側も
   * 完全」という形になり、**「全部持っているか」では完全性を判定できない。**
   * 判定したいのは「窓の範囲を全部持っているか」なので、覆った範囲を記録する。
   *
   * **任意。**古いレコードには無く、その場合は `itemTotalLikes` と保持件数の
   * 突き合わせに落ちる（そちらは「全部持っている」ことの判定）。
   */
  itemCoveredMinutes?: number;
}

/**
 * 窓内占有率の内訳。**割合ではなく実人数で持つ。**
 *
 * 「100%」は 10/10 とも 5/5 とも読める（2026-08-25 のユーザー指摘）。
 * 比に丸めた時点で強さが読めなくなるので、分子と分母をそのまま保持する。
 *
 * **単位はアカウント。**(アカウント × 記事) の組で数えると、3 記事とも押した
 * 人が 3 回数えられ、`clusterSize` と単位が食い違う。実機で「3 記事の合計」が
 * 1 記事のいいね数を超え、**オーバーフローしていると読まれた**。
 */
export interface WindowShare {
  /** 窓内にいいねしたアカウントのうち、クラスタに属するもの。**clusterSize 以下** */
  cluster: number;
  /** 窓内に根拠記事のどれかをいいねした実人数。**クラスタ外も含む** */
  total: number;
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

/**
 * ミュートを試みた結果。**例外ではなく値で返す**（DOM 層は投げない・約束 3）。
 *
 * **popup-state.ts が使うのでここに置く。**dom/muter.ts に置くと、
 * ポップアップが DOM 操作モジュールを import することになる（ポップアップに
 * トレンドページの DOM は無い）。RateLimitError を lib/errors.ts に集めたのと
 * 同じ理由 — 型は「使う側が全員たどり着ける場所」に置く。
 *
 * `menu-unavailable` は「メニューに『投稿ユーザーをミュート』が無かった」。
 * **既にミュート済みの場合もここに入る** — 項目がトグルで文言が変わるため、
 * 完全一致では見分けられない。**見分けようとしない**（解除の文言を実装に
 * 持ち込むと、それを押してしまう経路ができる）。UI の文言で両方を言う。
 *
 * | 値 | 意味 |
 * |---|---|
 * | `muted` | Snackbar で完了を確認した |
 * | `not-on-page` | その著者のカードが表示中のページに無い（トレンドが入れ替わった等） |
 * | `menu-unavailable` | 三点メニューか「投稿ユーザーをミュート」が無い。**既にミュート済みを含む** |
 * | `timeout` | クリックしたが Snackbar が出なかった。成功しているかは不明 |
 * | `no-trend-tab` | トレンドページを開いているタブが無い |
 * | `unreachable` | タブに届かなかった（拡張のリロードで content script が孤児になった等） |
 *
 * **配列から型を導出する。**storage から読んだ値とメッセージで届いた値の
 * 両方を検証する必要があり、一覧を 2 箇所に書くと片方だけ直すことになる。
 */
export const MUTE_OUTCOMES = [
  'muted',
  'not-on-page',
  'menu-unavailable',
  'timeout',
  'no-trend-tab',
  'unreachable',
] as const;

export type MuteOutcome = (typeof MUTE_OUTCOMES)[number];

/**
 * 外部から来た値が MuteOutcome かを判定する。
 * storage の中身も別コンテキストからのメッセージも、自分が書いたとは限らない
 */
export function isMuteOutcome(value: unknown): value is MuteOutcome {
  return typeof value === 'string' && (MUTE_OUTCOMES as readonly string[]).includes(value);
}

export interface MuteRecord {
  outcome: MuteOutcome;
  at: IsoDateTime;
  /**
   * 最後にミュートに **成功** した時刻。一度立ったら消えない。
   *
   * 【なぜ outcome と別に持つのか】
   * **ミュートすると Qiita がその著者の記事をトレンドから外す**（2026-08-24 実機）。
   * そのあと同じ候補で「妥当」を押し直すと、カードが無いので `not-on-page` になる。
   * outcome だけだと「まだミュートできていない」と読めてしまい、UI が
   * 「次に出てきたときに押し直してください」と**起こり得ないこと**を案内する。
   *
   * 成功したという事実は取り消されないので、上書きせずに積む。
   */
  mutedAt?: IsoDateTime;
}

/** 著者ハンドル -> 最後にミュートを試みた結果。UI に出すためだけに持つ */
export type MuteLog = Record<AccountHandle, MuteRecord>;

/**
 * ポップアップの一覧で折りたたむ対象。**表示の設定であって判定ではない。**
 *
 * | 値 | 意味 |
 * |---|---|
 * | `none` | 折りたたまない（**既定**） |
 * | `muted` | 一度でもミュートに成功した著者だけ |
 * | `valid` | 「妥当」と評価した著者だけ |
 * | `judged` | 「妥当」「誤り」いずれかを評価した著者すべて |
 *
 * **既定が none なのは、視界から消す方向の変更だから。**
 * 誤検知でミュートしたアカウントを再評価できなくする失敗（OQ-16）と
 * 同じ形を持つ。折りたたんだ中でも「誤り」が押せることで回収経路を残す。
 *
 * **配列から型を導出する**（MUTE_OUTCOMES と同じ）。storage から読んだ値を
 * 検証する必要があり、一覧を 2 箇所に書くと片方だけ直すことになる。
 */
export const FOLD_TARGETS = ['none', 'muted', 'valid', 'judged'] as const;

export type FoldTarget = (typeof FOLD_TARGETS)[number];

/** 外部から来た値が FoldTarget かを判定する。storage の中身は自分が書いたとは限らない */
export function isFoldTarget(value: unknown): value is FoldTarget {
  return typeof value === 'string' && (FOLD_TARGETS as readonly string[]).includes(value);
}

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
  /**
   * 0.0-1.0。投稿直後に集中したいいねの割合。
   * **「投稿直後」の幅は `Settings.burstWindowMinutes`**（ユーザーが決める）
   */
  burstScore: number;
  /** 0.0-1.0。クラスタのうち記事 0 本・プロフィール空のアカウントの割合 */
  emptyAccountRatio: number;
  /**
   * 窓内占有率。**分母は「その記事の窓内いいね総数」**であって、
   * クラスタのいいね数ではない（そちらが burstScore）。
   *
   *   burstScore  = クラスタの窓内いいね（件） / **クラスタ**のいいね総数（件）
   *   windowShare = 窓内のクラスタ**アカウント数** / **窓内にいいねした実人数**
   *
   * 前者は「彼らが早く押したか」、後者は「**早い時間帯を彼らが占めたか**」。
   * 実測（2026-08-25）で 2 人の著者を区別できたのは後者だけだった
   * （どの幅でも 80〜95% の著者と、2 日で 43% まで薄まる著者）。
   *
   * **測れなければ null。**「測ったら 0% だった」と区別する
   * （適合率の分母 0 を 0% にしないのと同じ話）。
   */
  windowShare: WindowShare | null;
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
  /**
   * 「投稿直後」とみなす幅（分）。**候補の件数は変えない。**
   *
   * `burstScore` の計算に効くので `detectCandidates` の入力ではあるが、
   * その値は**表示と並び順のタイブレークにしか使われない**（burst.ts）。
   *
   * 【なぜ「下限で絞る」を作らないのか】
   * **いつ押すかを握っているのは攻撃側である。**下限を設けると、手口を知った
   * 相手は時刻をずらすだけで候補から消える。しかも消えたことはユーザーに
   * 見えないので、**善意で下限を上げた人が実在の手口を静かに取りこぼす**
   * （`emptyAccountRatio` を開放しないのと同じ理由）。
   *
   * 幅を動かせることの価値は絞り込みではなく**探索**にある。60 分で 0.00 の
   * 著者が 180 分で 1.00 になれば、それはユーザーが遅延に気づいたということ。
   * 下限はその発見を先回りして潰してしまう。
   */
  burstWindowMinutes: number;
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
 *
 * **`burstWindowMinutes` は 60 → 180 に変えた**（Phase 9・ユーザー確定）。
 *
 * これは「既定値は現状維持」の唯一の例外。**候補の件数は変わらない**
 * （下限を撤回したので burstScore は絞り込みに使われない）が、
 * **保存済み設定が無い人のスコア表示と並び順のタイブレークは変わる。**
 * 60 分は「通知を見てすぐ読んだ人」と区別がつきにくく、初期値としては狭すぎた。
 */
export const DEFAULT_SETTINGS: Settings = {
  minClusterSize: 5,
  minSharedItems: 2,
  lookbackDays: 7,
  burstWindowMinutes: 180,
};

const MINUTES_PER_DAY = 60 * 24;

/**
 * 「投稿から何分以内」で選べる値（分）。**等間隔ではない。**
 *
 * 短い側は 1 時間刻みで細かく、長い側は日単位まで伸ばす。組織票の signature は
 * 「投稿から間もない集中」だが、**手口を知られれば時刻はずらせる**ので遅い側も
 * 見られる必要がある（`detect/burst.ts` のヘッダー）。
 * スライダーは**この配列の添字**を値にする（60→2880 は等間隔に載らない）。
 *
 * 【なぜ UI ではなくここに置くか】
 * **取得層が最大値を知る必要がある。**likes は降順で返るので、100 件を超える
 * 記事では末尾から遡って取る。どこまで遡るかは「ユーザーが選びうる最大の窓」で
 * 決まる。UI と取得層の 2 箇所に同じ目盛りを持つと、片方だけ直す事故が必ず起きる。
 */
export const BURST_WINDOW_CHOICES = [60, 120, 180, 360, 720, MINUTES_PER_DAY, MINUTES_PER_DAY * 2];

/**
 * ユーザーが選びうる最大の窓（分）。**取得の射程を決める。**
 *
 * 配列から導出する。**定数で 2880 と書かない** — 目盛りを足したときに
 * 取得側が追随せず、選べるのに測れない窓ができる。
 */
export const MAX_BURST_WINDOW_MINUTES = Math.max(...BURST_WINDOW_CHOICES);

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
  /**
   * 「妥当」と同時に Qiita 側でもミュートするか。**既定は false。**
   *
   * Settings（sync）に入れないのは、あれが detectCandidates の入力だから。
   * 判定に関係しない値を混ぜない。明示的にオンにしたときだけ Qiita 側を変更する
   */
  muteOnValid?: boolean;
  /** ミュートを試みた結果。失敗の記録として持ち、ポップアップに出す */
  muteLog?: MuteLog;
  /**
   * 評価が済んだ候補を折りたたむ対象。**既定は 'none'。**
   *
   * Settings（sync）に入れないのは、あれが detectCandidates の入力だから。
   * これは表示の設定で判定に一切関与しない（muteOnValid と同じ扱い）
   */
  foldTarget?: FoldTarget;
  /** 著者ごとの過去記事巡回の記録。保持期間 7 日でパージする */
  authorVisits?: AuthorVisits;
  /** 保持期間 7 日 */
  purgeAfter?: IsoDateTime;
  /** 最後にスキャンした時刻 */
  lastScanAt?: IsoDateTime;
  /** 最後のスキャン結果 */
  lastScanResult?: ScanResult;
}
