/**
 * ストア掲載用スクリーンショットのためのダミーの検出結果（fixture）。
 *
 * **`npm run build:fixture`（`vite build --mode fixture`）のときだけ中身を持つ。**
 * 本番ビルドでは {@link FIXTURE_SCENE} が `null` に畳まれ、ダミーデータは
 * 1 文字も同梱されない（`dist/` を `demo-author` で grep して 0 件）。
 *
 * 【なぜ DOM を書き換えて撮らないのか】
 * 表示中のポップアップのハンドルを手で置き換える方式は、置き換え漏れが出る
 * （見出し・本文・リンク先・coAuthors の行と、名前の出る場所が複数ある）。
 * 検出結果そのものをダミーにすれば、**実在のアカウント名が画面に届く経路が無い。**
 *
 * 【なぜ `src/detect/` の出力で差し替えるのか】
 * DOM 層・UI 層で差し込むと、実データの経路とダミーの経路が混ざる。
 * `detectCandidates` の戻り値を丸ごと差し替えれば、UI は本番と同じコードで描く
 * — スクショに写るのは本番と同じ描画である。
 *
 * 【ここに置く値の約束】
 *   - ハンドルは `demo-author-N` / `demo-member-X`。**実在しないと一目でわかる形**
 *   - 記事 ID は `demo-item-…`。Qiita の記事 ID は 16 進 20 桁なので、
 *     ハイフンを含む時点で**実在の記事 ID と衝突しえない**
 *   - 数字は閾値（既定 5 アカウント / 2 記事）を**はっきり超える**。1/2 (50%) の
 *     ような小さい母数は、機能の説明として弱い
 *   - 空の状態（「まだいません」「測れません」）は入れない
 *   - 状態を 1 件ずつ持たせる: 評価前 / 評価済み（妥当）/ ミュート済み
 *   - 日時はすべて固定。撮り直しても同じ画面になる
 */
import type { Candidate, FeedbackLog, MuteLog, ScanResult } from '../types/domain';

/** スクショ 1 枚ぶんの状態。検出結果と、それに重なる評価・ミュート・最終スキャン */
export interface FixtureScene {
  candidates: readonly Candidate[];
  feedback: Readonly<FeedbackLog>;
  muteLog: Readonly<MuteLog>;
  scanResult: Readonly<ScanResult>;
}

/** スキャンを終えたことにする時刻。JST 2026-09-20 12:15 */
const SCANNED_AT = '2026-09-20T03:15:00.000Z';

/** ミュート済みを確認したことにする時刻。スキャンの 5 分後 */
const MUTED_AT = '2026-09-20T03:20:00.000Z';

/** `demo-member-a` から始まる連番のメンバー。クラスタの顔ぶれ */
function members(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `demo-member-${String.fromCharCode(97 + i)}`);
}

/** `demo-item-<著者番号><記事番号>`。16 進ではないので実在の記事 ID と衝突しない */
function items(author: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `demo-item-${String(author)}${String(i + 1)}`);
}

/**
 * ダミーの候補。**`detectCandidates` と同じ並び**（clusterSize の降順）にしてある。
 *
 * | 著者 | 状態 | アカウント | 記事 | 窓内占有率 |
 * |---|---|---|---|---|
 * | demo-author-1 | 評価前（著者間の共起あり） | 14 | 4 | 12/14 (86%) |
 * | demo-author-2 | 評価済み（妥当） | 11 | 3 | 9/10 (90%) |
 * | demo-author-3 | ミュート済み | 9 | 3 | 8/9 (89%) |
 * | demo-author-4 | 評価前（著者間の共起あり） | 8 | 3 | 7/8 (88%) |
 *
 * 1 と 4 は同じメンバーが両方の記事に現れた形（coAuthors の行を写すため）。
 */
function buildScene(): FixtureScene {
  return {
    candidates: [
      {
        authorHandle: 'demo-author-1',
        clusterAccounts: members(14),
        clusterSize: 14,
        sharedItemIds: items(1, 4),
        sharedItemCount: 4,
        burstScore: 0.93,
        emptyAccountRatio: 0.64,
        windowShare: { cluster: 12, total: 14 },
        detectedAt: SCANNED_AT,
        coAuthors: ['demo-author-4'],
      },
      {
        authorHandle: 'demo-author-2',
        clusterAccounts: members(11),
        clusterSize: 11,
        sharedItemIds: items(2, 3),
        sharedItemCount: 3,
        burstScore: 0.88,
        emptyAccountRatio: 0.55,
        windowShare: { cluster: 9, total: 10 },
        detectedAt: SCANNED_AT,
      },
      {
        authorHandle: 'demo-author-3',
        clusterAccounts: members(9),
        clusterSize: 9,
        sharedItemIds: items(3, 3),
        sharedItemCount: 3,
        burstScore: 0.9,
        emptyAccountRatio: 0.44,
        windowShare: { cluster: 8, total: 9 },
        detectedAt: SCANNED_AT,
      },
      {
        authorHandle: 'demo-author-4',
        clusterAccounts: members(8),
        clusterSize: 8,
        sharedItemIds: items(4, 3),
        sharedItemCount: 3,
        burstScore: 0.86,
        emptyAccountRatio: 0.5,
        windowShare: { cluster: 7, total: 8 },
        detectedAt: SCANNED_AT,
        coAuthors: ['demo-author-1'],
      },
    ],
    // 評価済み（妥当）とミュート済みの 2 件。1 と 4 は評価前のまま
    feedback: { 'demo-author-2': 'valid', 'demo-author-3': 'valid' },
    // ミュート済みを確認した記録。「妥当」と同時にミュートした流れを模す
    muteLog: { 'demo-author-3': { outcome: 'muted', at: MUTED_AT, mutedAt: MUTED_AT } },
    // ポップアップの「最終スキャン …」はこの finishedAt を出す
    scanResult: {
      mode: 'light',
      newItemCount: 30,
      scannedItemCount: 30,
      likeRecordCount: 412,
      startedAt: '2026-09-20T03:14:12.000Z',
      finishedAt: SCANNED_AT,
    },
  };
}

/**
 * fixture ビルドの状態。**本番ビルドでは `null`。**
 *
 * 【フラグとデータを 1 つの式にまとめた理由】（2026-09-28 実測）
 * 最初は `FIXTURE_BUILD` というフラグと候補の配列を別々に export し、
 * 使う側で `if (FIXTURE_BUILD)` と分岐していた。分岐は本番で消えたが、
 * **配列は `dist/` に残った** — バンドラ（Vite 8 / Rolldown）は、使う側の分岐を
 * 消す前にチャンクの export を決めるため、到達しない import でも export が残る。
 * ここで `import.meta.env.MODE` を直接比べれば、本番では `'production' === 'fixture'`
 * が畳まれて `null` だけが残り、**データを作る式そのものが消える。**
 *
 * **実行時の設定値にしてはいけない。**畳まれなくなり、本番にダミーが同梱される。
 */
export const FIXTURE_SCENE: FixtureScene | null =
  import.meta.env.MODE === 'fixture' ? buildScene() : null;

/**
 * `detectCandidates` の戻り値として使う。**呼ぶたびに複製を返す** —
 * 呼び出し側が並べ替えたり書き換えたりしても、次の呼び出しに漏れない。
 */
export function sceneCandidates(scene: FixtureScene): Candidate[] {
  return scene.candidates.map((candidate) => structuredClone(candidate));
}

/** テスト用。ビルドの mode に関係なく同じ状態を作る */
export { buildScene as buildFixtureScene };
