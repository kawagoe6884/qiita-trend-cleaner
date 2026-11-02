/**
 * ポップアップに出す文言のうち、ミュート以外のもの。**純粋関数だけを置く。**
 *
 * 【なぜ popup-state から分けたのか】（2026-11-02）
 * popup-state が 947 行になり、ソースファイルの目安（800 行）を超えた。
 * 状態を読む・書く関数（storage と chrome.tabs を触る）と、受け取った値から
 * 文を作るだけの関数を分けた。**振る舞いは変えていない。**
 * ミュートの行の文言は popup-mute-copy にある。
 */
import { RATE_LIMIT_ANON, RATE_LIMIT_AUTH } from '../../api/rate-budget';
import type { AccountHandle, Candidate, FoldTarget, IsoDateTime } from '../../types/domain';
import type { AuthorCoverage } from '../../detect/like-index';
import type { CandidateView, Precision } from './popup-state';

/**
 * 折りたたみの見出し。**0 件なら空文字を返し、器ごと出さない**
 * （describeCoAuthors と同じ規約）。
 */
export function describeFold(target: FoldTarget, count: number): string {
  if (target === 'none' || count === 0) return '';
  const label =
    target === 'muted' ? 'ミュート済み' : target === 'valid' ? '「妥当」と評価した' : '評価済み';
  return `${label} ${String(count)} 件`;
}

/**
 * 候補の一覧に添える一言。
 *
 * 数字だけを並べると、**何を求められているのかが伝わらない。**
 * 適合率はユーザーが「妥当 / 誤り」を押さない限り永久に出ないので、
 * 押してほしいことをこちらから言う。それが唯一の指標の入力経路である。
 *
 * 【何に対する判断かを必ず書く】
 * 評価する対象は **検出そのもの**（当たっていたか）であって、著者の人格ではない。
 * それを書かずに「妥当 / 誤り」とだけ出すと、何を訊かれているのか分からない。
 * 「不正」「スパム」と断定しないこと（設計上の約束 6）とは別の話で、
 * **断定しないことと、何を訊いているか言わないことは違う。**
 */
export function describeCall(views: CandidateView[], precision: Precision): string {
  if (views.length === 0) return '';
  if (precision.ratio === null) {
    return 'この検出が当たっているか、根拠の記事を読んで「妥当 / 誤り」で記録してください。';
  }
  const unjudged = views.filter((view) => view.verdict === null).length;
  if (unjudged > 0) return `未評価があと ${String(unjudged)} 件あります。`;
  return 'この一覧はすべて評価済みです。';
}

/**
 * 同じクラスタが現れた他の著者の案内。**無ければ空文字を返し、行ごと出さない。**
 *
 * 根拠記事はこの著者のぶんしか持たない（popup-state が根拠 URL を
 * authorHandle から組み立てるため）。他の著者の記事を見たければ、その著者の
 * 候補を開けば根拠リンクがある。**ただし、その著者がトレンド外なら一覧には居ない**
 * （hideOffTrend。2026-11-02）。名前は出すが、候補が並んでいるとは限らない。
 *
 * **断定しない**（設計上の約束 6）。「組織票」「不正」とは書かない。
 */
export function describeCoAuthors(coAuthors: AccountHandle[] | undefined): string {
  if (coAuthors === undefined || coAuthors.length === 0) return '';
  return `同じメンバーが ${coAuthors.join('、')} の記事にも現れています。`;
}

/**
 * 候補ゼロのときの案内。**原因ごとに言い分ける。**
 *
 * 蓄積がまだ無いのか、蓄積はあるが条件が厳しいのか、折りたたみの中に居るのかで、
 * 次にやることが違う。1 つの文言にすると、スライダーを上げてゼロになった人に
 * 「トレンドページを開いてください」と的外れな案内を出すことになる。
 *
 * 【スナップショットの時刻に紐づけて範囲を言う】（2026-11-02）
 * トレンド外の候補は hideOffTrend で外しているので、範囲を言わないと保存済みの
 * 候補があるのに「当てはまる候補はありません」が嘘になる。**「いまのトレンド」とは
 * 言わない** — 絞りに使った記録はトレンドを最後に開いた時点のもので、2 日開いて
 * いなければ 2 日前のもの（TrendSnapshot の JSDoc）。スナップショットが無ければ
 * 1 件も絞っていないので、範囲は言わない。
 */
export function describeEmpty(
  hasIndex: boolean,
  foldedCount = 0,
  trendSnapshotAt: IsoDateTime | null = null,
): string {
  // 折りたたみの中に居るのに「条件をゆるめると増えます」と言うと、
  // 何もしていない人に条件をいじらせることになる
  if (foldedCount > 0) return '出ている候補はすべて折りたたみの中にあります。';
  if (!hasIndex) return 'まだ何も集めていません。トレンドページを開くと蓄積が始まります。';
  const scope =
    trendSnapshotAt === null
      ? 'いまの条件に'
      : `${formatJst(trendSnapshotAt)} に読み込んだトレンドには、条件に`;
  return `${scope}当てはまる候補はありません。条件をゆるめると増えます。`;
}

const MINUTES_PER_DAY = 60 * 24;

/** 幅の表示。1 日以上は日で言う（「1440 分」は読めない） */
export function describeWindow(minutes: number): string {
  if (minutes >= MINUTES_PER_DAY && minutes % MINUTES_PER_DAY === 0) {
    return `${String(minutes / MINUTES_PER_DAY)} 日`;
  }
  return `${String(minutes)} 分`;
}

/** 0.0-1.0 を百分率の整数にする。0.98 → 98 */
function toPercent(ratio: number): string {
  return String(Math.round(ratio * 100));
}

/**
 * 窓内占有率の行。**候補 1 件の見出しになる数字。**
 *
 * 【burstScore を画面から降ろした】
 * `burstScore` は「**クラスタのいいね**のうち窓内だったもの」で、彼らが早く
 * 押したかしか言わない。実測（2026-08-25）では、どの幅でも 80〜95% の著者と、
 * 180 分で 79% ／ 2 日で 43% まで薄まる著者を **burstScore では区別できなかった**。
 * 分けたのは占有率だけだった。並び順のタイブレークには引き続き使う。
 *
 * 【実件数を書く】
 * 「100%」は 10/10 とも 5/5 とも読める。％だけにすると強さが読めない。
 *
 * 【3 つの状態を言い分ける】
 *   - null      … **測れない**（いいねの多い記事を含み、分母が欠けている）
 *   - total = 0 … 測ったが窓内にいいねが無かった
 *   - それ以外  … 件数と割合
 * 「測れない」と「測ったら 0 だった」を混ぜると、条件を動かす方向が逆になる
 * （適合率の分母 0 を 0% にしないのと同じ話）。
 */
export function describeWindowShare(candidate: Candidate, windowMinutes: number): string {
  // **「該当記事の」を付ける。**見出しが「3 記事に重なった」と言っているので、
  // どの記事の話かをこの行だけで読めるようにする
  const scope = `該当記事の投稿から ${describeWindow(windowMinutes)}以内`;
  // 保存済みの古い候補にはこのフィールドが無い。undefined も「測れない」に倒す
  const share = candidate.windowShare ?? null;
  if (share === null) return `${scope}の占有率は測れません (いいねの多い記事を含みます)`;
  if (share.total === 0) return `${scope}にいいねした人はまだいません`;
  const ratio = toPercent(share.cluster / share.total);
  return `${scope}にいいねした ${String(share.cluster)}/${String(share.total)} アカウント (${ratio}%) が同じメンバー`;
}

export interface ModeCopy {
  title: string;
  detail: string;
  action: string;
}

/**
 * ライトモードで何が足りないかを、**手元の蓄積の実数で**言う。
 *
 * 以前ここは「同じ著者の記事が複数トレンドに出ていないと判定材料が揃いません」
 * という固定の文だった。**Phase 5b-2 以降これは誤り**で、記事 1 本の著者は
 * 著者をまたぐ共起が拾う（そのために足した軸である）。断定を避けるだけでなく、
 * 事実として間違っていた。
 *
 * **実数にするのは、日によって大きく振れるから。**2026-08-30 のトレンドは
 * 26 著者中 23 人が記事 1 本、2026-08-20 は 5 著者が 30 枠中 13 を占めていた。
 * 固定の文言ではその日の状況を伝えられない。
 */
function describeLightGap(coverage: AuthorCoverage): string {
  // 蓄積が無ければ数える対象も無い。0 人と書くと「足りていない人は居ない」に読める
  if (coverage.solo === 0) return '';
  return `蓄積している ${String(coverage.total)} 人の著者のうち ${String(coverage.solo)} 人は記事が 1 本で、同じ著者の中では共起を見られません (別の著者との共起でのみ拾えます)。`;
}

/**
 * 動作モードの説明。**トークンそのものは扱わず、有無だけを受ける。**
 * 枠の数値は rate-budget の定数から作り、UI に直書きしない。
 */
export function describeMode(hasToken: boolean, coverage: AuthorCoverage): ModeCopy {
  if (hasToken) {
    return {
      title: 'フルモードで動作中',
      detail: `著者の過去記事まで辿ります。1 時間あたり ${String(RATE_LIMIT_AUTH)} リクエストまで使えます。`,
      action: 'トークンを変更する',
    };
  }
  // 枠の広さより先に「何が足りないか」を言う。**断定はしない**（約束 6）—
  // ライトでも検出できる（蓄積ゼロの初回スキャンで 5 候補・OQ-12）
  return {
    title: 'ライトモードで動作中',
    detail: `トレンド記事のいいねだけを見ます。${describeLightGap(coverage)}トークンを設定すると著者の過去記事まで辿れ、1 時間あたりの枠も ${String(RATE_LIMIT_ANON)} → ${String(RATE_LIMIT_AUTH)} リクエストに広がります。`,
    action: 'トークンを設定する',
  };
}

/**
 * 保存は ISO 8601（UTC）だが、読む人は JST で暮らしている。
 * timeZone を明示するので、実行環境のタイムゾーンに依存しない。
 */
export function formatJst(iso: IsoDateTime): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
