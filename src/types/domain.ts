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

/**
 * 直近に**新規ロード**したトレンドページに出ていた著者。
 *
 * 【これが何を証明するか】
 * ミュート済みの著者の記事は、**次にページを読み込んだとき**にトレンドから外れる
 * （押した直後は DOM に残ったまま。2026-09-16 実測）。content script は
 * `TREND_ITEMS` を**読み込み時に 1 回だけ**送るので、ここに載っている著者は
 * **その時点でミュートされていない**ことが確定する。三点メニューを開いて文言を
 * 読む必要はない — 追加リクエストもクリックも 0 で、同じ事実が得られる。
 *
 * 【`at` を持つ理由】
 * スナップショット自体が古くなる。トレンドを 2 日開いていなければ、ここに
 * 「居ない」ことは**いまの不在を意味しない**。UI は必ず `at` に紐づけて言う。
 */
export interface TrendSnapshot {
  authors: AccountHandle[];
  at: IsoDateTime;
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
   * **「全部持っているか」では完全性を判定できない。**欠け方が 2 通りあり、
   * どちらもこの 1 つの値に集約される。
   *
   *   件数で欠ける: likes は降順（新しい順）で返るので、100 件を超える記事では
   *     末尾ページから遡って取る。インデックスは「古い側は完全・真ん中が欠け・
   *     新しい側も完全」という形になる（2026-08-25）
   *   時間で欠ける: 記事は 1 度しか取らない（scanner の known / seen）のに、窓は
   *     投稿から先へ伸び続ける。**投稿 20 分後に取った記事は、その時点の全部を
   *     持っていても 180 分の窓を覆えていない**（2026-08-30）
   *
   * 判定したいのは「窓の範囲を全部持っているか」なので、覆った範囲を記録する。
   * 値は**遡ったときは最後に取ったページの最新いいね、それ以外は取得時点の
   * 経過分**。後者を書いていなかったせいで、時間の欠けを誰も判定できなかった。
   *
   * **任意。**投稿時刻が読めない／未来のときは付かない。この機能より前に
   * 取った古いレコードにも無く、その場合は `itemTotalLikes` と保持件数の
   * 突き合わせに落ちる（そちらは「取得時点の全部を持っている」ことの判定にすぎず、
   * **窓を覆えたかは分からない**）。
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
 * 【`already-muted` を新設した理由】（2026-08-29）
 * 項目はトグルで、ミュート中は「投稿ユーザーのミュートを解除」に変わる。
 * 以前は解除の文言を**実装に持ち込まない**方針だったため、既にミュート済みは
 * `menu-unavailable` に落ち、UI が「既にミュート済みか、画面構造が変わった
 * 可能性」と**推測を並べる**しかなかった。解除の文言を**読む対象としてだけ**
 * 持てば、推測が事実に変わる。**押す経路は増やさない** — 分類にのみ使い、
 * `click()` には決して渡さない（`dom/muter.ts` の `findUnmuteItem`）。
 *
 * | 値 | 意味 |
 * |---|---|
 * | `muted` | 押して、Snackbar で完了を確認した |
 * | `already-muted` | **押していない。**項目が解除側だったので、既にミュート中と分かった |
 * | `not-on-page` | その著者のカードが表示中のページに無い（トレンドが入れ替わった等）。**トレンド外と分かっている候補では、ポップアップが依頼を送らずにこれを記録する**（`skipMute`） |
 * | `menu-unavailable` | 三点メニューが開かない、または**どちらの文言も無い**（画面構造の変化） |
 * | `timeout` | クリックしたが Snackbar が出なかった。成功しているかは不明 |
 * | `no-trend-tab` | トレンドページを開いているタブが無い |
 * | `unreachable` | タブに届かなかった（拡張のリロードで content script が孤児になった等） |
 *
 * **配列から型を導出する。**storage から読んだ値とメッセージで届いた値の
 * 両方を検証する必要があり、一覧を 2 箇所に書くと片方だけ直すことになる。
 * `describeMuteOutcome` の switch に `default` を書いていないので、
 * **値を足したとき文言の追加漏れは型エラーで出る。**
 */
export const MUTE_OUTCOMES = [
  'muted',
  'already-muted',
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
   * ミュート済みだと**最後に確認できた**時刻。
   *
   * 【なぜ outcome と別に持つのか】
   * ミュートしたあと同じ候補で押し直すと、**ページを読み込み直す前なら**カードが
   * DOM に残っているので `already-muted`、読み込み直したあとなら記事ごと消えるので
   * `not-on-page` が返る。outcome だけだとどちらも「まだミュートできていない」と
   * 読めてしまい、UI が「次に出てきたときに押し直してください」と案内していた。
   *
   * 【~~一度立ったら消えない~~ → 2026-09-16 に撤回】
   * ユーザーが Qiita 側で解除すると、その著者の記事は**次のページ読み込みから**
   * トレンドに戻る。戻った著者は {@link TrendSnapshot} に現れるので、そのとき
   * 記録ごと捨てる（`storage.forgetMuteConfirmation`）。捨てないと
   * **解除したのに「ミュート済み」と言い続ける。**
   *
   * 【消せないことがある】
   * 解除された著者がトレンドに戻ってこなければ、証拠は永久に届かない。だから
   * 文言はこの時刻に紐づけて言う（`describeMuteRecord`）— 「いまミュート中です」は
   * いつか偽になるが、「この時刻に確認しました」は偽にならない。
   */
  mutedAt?: IsoDateTime;
}

/**
 * 著者ハンドル -> 最後にミュートを試みた結果、またはトレンド外で見送った記録
 * （ポップアップの `skipMute` が送らずに `not-on-page` を書く）。UI に出すためだけに持つ
 */
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
export const BURST_WINDOW_CHOICES = [
  60,
  120,
  180,
  360,
  720,
  MINUTES_PER_DAY,
  MINUTES_PER_DAY * 2,
] as const;

/**
 * ユーザーが選びうる最大の窓（分）。**取得の射程を決める。**
 *
 * 配列から導出する。**定数で 2880 と書かない** — 目盛りを足したときに
 * 取得側が追随せず、選べるのに測れない窓ができる。
 */
export const MAX_BURST_WINDOW_MINUTES = Math.max(...BURST_WINDOW_CHOICES);

/**
 * 「AI文体かも？」の材料になる文体シグナル。**1 つ立つごとに 1 点。**
 *
 * 出典: 「Qiita の文章は生成 AI 以前と以後でどう変わったか」
 * （https://nyosegawa.com/posts/qiita-writing-before-after-ai/）。
 * **集団の傾向**の測定であって、記事単位の判定器ではない。点数は
 * 「AI 記事である」の根拠ではなく、利用者が開く前に目安を得るためのもの。
 *
 * 重みを付けないのは、そうかも / 違うかもの回答で閾値を自動調整しないと決めたから
 * （PRD）。利用者が動かせるのは「何点以上で強調するか」だけにする。
 *
 * **配列から型を導出する**（FOLD_TARGETS と同じ）。storage から読んだ値を検証する。
 */
export const AI_SIGNALS = [
  /** 1 文あたりの読点が多い */
  'commaDensity',
  /** 太字が多い */
  'boldDensity',
  /** 箇条書きの行が多い */
  'bulletRatio',
  /** ダッシュ（— ―）を使う */
  'dash',
  /** 「まとめ」見出しがある */
  'summaryHeading',
  /** 生成 AI 以後に増えた語（効く・既定・実測 など）を使う */
  'risingWords',
  /** 生成 AI 以後に減った表現（〜ましょう・感嘆符・「また、」）を使わない */
  'noFallingExpressions',
  /** 地の文が長い */
  'longProse',
] as const;

export type AiSignal = (typeof AI_SIGNALS)[number];

/** 外部から来た値が AiSignal かを判定する */
export function isAiSignal(value: unknown): value is AiSignal {
  return typeof value === 'string' && (AI_SIGNALS as readonly string[]).includes(value);
}

/**
 * 地の文がこれ未満の記事は「短文のため判定が甘い可能性あり」と注釈する。
 *
 * **334 は遊び心**（PRD・ユーザー確定）。2026 年の平均文長約 39 字で 8〜9 文。
 * 対象外にはせず、表示したうえで注釈する（Plan D4）。
 */
export const AI_HINT_MIN_PROSE_CHARS = 334;

/**
 * 「AI文体かも？」を強調する既定の点数（以上）。**仮置き。**
 *
 * 根拠のある値が無いので、シグナル数の過半に置いている（Plan D3）。
 * 30 件の回答で一致率を見て決め直す（設定画面の一致率の表 — M3）。利用者は設定画面で変えられる（M2）。
 */
export const AI_HINT_DEFAULT_THRESHOLD = 5;

/**
 * 強調する点数の範囲。0 は全件強調で意味がないので 1 から。
 * 上限はシグナル数から導出する（シグナルが増えても追従する）
 */
export const AI_HINT_THRESHOLD_RANGE = { min: 1, max: AI_SIGNALS.length } as const;

/**
 * 記事 1 件の点数としてありうる範囲（立ったシグナルの数）。
 * 保存された回答の点数を読むときの検証に使う（範囲外は壊れた値として捨てる）
 */
export const AI_HINT_SCORE_RANGE = { min: 0, max: AI_SIGNALS.length } as const;

/**
 * 最小文字数の範囲。**0 は「注釈を出さない」。**
 * 上限は入力ミス（桁違い）を弾くためのもので、根拠のある値ではない
 */
export const AI_HINT_MIN_PROSE_RANGE = { min: 0, max: 2000 } as const;

/**
 * 整数かつ範囲内か。**丸めない** — 3.5 を 4 にすると、壊れた値がそれらしく見えてしまう。
 * storage の読み込みと設定画面の入力の両方で使う
 */
export function isIntInRange(value: unknown, range: { min: number; max: number }): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max
  );
}

/**
 * 「AI文体かも？」の線引き（M2）。**表示の設定で、点数の計算には関与しない。**
 *
 * 変わるのは「何点以上を強調するか」と「何字未満に注釈を付けるか」だけ。
 * 保存済みのスコアも回答も書き換えない。
 */
export interface AiHintPrefs {
  /** この点数以上を強調する */
  threshold: number;
  /** 地の文がこれ未満なら短文の注釈を付ける */
  minProseChars: number;
  /**
   * 強調される記事のカードを薄く表示するか（M4）。**既定は false。**
   *
   * 自動非表示の代わり（PRD「検証後の再検討」）。隠さず、乗せれば戻り、
   * ヒントと回答ボタンは薄くしない。視界を狭める変更なので FoldTarget と同じく既定はオフ
   */
  dimLikely: boolean;
}

export const DEFAULT_AI_HINT_PREFS: AiHintPrefs = {
  threshold: AI_HINT_DEFAULT_THRESHOLD,
  minProseChars: AI_HINT_MIN_PROSE_CHARS,
  dimLikely: false,
};

/**
 * 記事 1 件の文体スコア。**本文そのものは持たない**（Plan D5）。
 * 本文は取得してその場で数え、捨てる。
 */
export interface AiHint {
  /** 立ったシグナル（重複なし・AI_SIGNALS の順） */
  fired: AiSignal[];
  /** コード・表・引用を除いた地の文の文字数（空白を除く） */
  proseChars: number;
  /** 数えた時刻。保持期間（7 日）の判定に使う */
  scoredAt: IsoDateTime;
}

/** 記事 ID -> 文体スコア。保持期間 7 日でパージする */
export type AiHintLog = Record<ItemId, AiHint>;

/**
 * 「AI文体かも？」への利用者の答え。**yes =「そうかも」、no =「違うかも」。**
 *
 * M3 で「当たり / 外れ」から言い換えた（判定口調で角が立つ — 利用者確定）。
 * 強調の有無に関係なく「利用者が AI 文体だと思うか」を表す。
 */
export type AiVerdict = 'yes' | 'no';

/**
 * 1 記事への回答。**回答した瞬間の点数を一緒に残す**（M3 Plan D2）。
 *
 * スコアは 7 日でパージされ、線引きは M2 で動かせる。点数を残さないと、
 * 線引きを動かしたときの一致率を後から計算できない。
 */
export interface AiAnswer {
  verdict: AiVerdict;
  /**
   * 回答時の点数。**null は M3 より前の旧形式**（点数が残っていない）。
   * 当時のボタンは「Yes / No」「当たり / 外れ」で意味が今と違いうるので、一致率には入れない
   */
  score: number | null;
  /**
   * 回答時に立っていたシグナル（AI_SIGNALS の順）。**指標の見直しのために残す。**
   *
   * スコア（aiHints）は 7 日で消えるので、一致率が目標に届かなかったときに
   * 「どの指標が外れていたか」を回答から辿れるようにする（仮説の検証・利用者確定）。
   * null は、これを残す前の回答（M3 の初版と旧形式）。一致率の計算には使わない
   */
  fired: AiSignal[] | null;
  /** 回答した時刻。旧形式は null */
  answeredAt: IsoDateTime | null;
}

/**
 * 記事 ID -> 回答。一致率の唯一の入力。
 *
 * **閾値の自動調整には使わない**（PRD）。FeedbackLog と同じく、利用者が
 * 積み上げた資産なのでパージしない。
 */
export type AiVerdictLog = Record<ItemId, AiAnswer>;

/** 一致率を判定する回答数（PRD の Success Metrics: N = 30） */
export const AI_HINT_TARGET_ANSWERS = 30;

/** 目標の一致率（PRD の Success Metrics: 70%） */
export const AI_HINT_TARGET_AGREEMENT = 0.7;

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
  /** ミュートを試みた結果（トレンド外で見送った記録も含む）。失敗の記録として持ち、ポップアップに出す */
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
  /** 記事ごとの文体スコア（フルモードのみ）。保持期間 7 日でパージする */
  aiHints?: AiHintLog;
  /** 「AI文体かも？」への回答。パージしない */
  aiVerdicts?: AiVerdictLog;
  /**
   * 「AI文体かも？」の線引き。**既定は DEFAULT_AI_HINT_PREFS。**
   *
   * Settings（sync）に入れないのは、あれが detectCandidates の入力だから。
   * これは表示の設定で判定に一切関与しない（foldTarget と同じ扱い）
   */
  aiHintPrefs?: AiHintPrefs;
  /** 保持期間 7 日 */
  purgeAfter?: IsoDateTime;
  /** 最後にスキャンした時刻 */
  lastScanAt?: IsoDateTime;
  /** 最後のスキャン結果 */
  lastScanResult?: ScanResult;
}
