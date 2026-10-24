/**
 * 「AI文体かも？」の一致率の文言。純粋関数（DOM も storage も触らない）。
 *
 * token-form.ts と同じく、文言の決定を DOM の配線から分けてユニットテストで固定する。
 * 集計そのものは detect/ai-agreement.ts。
 */
import { judgeAgreement } from '../../detect/ai-agreement';
import { AI_HINT_TARGET_AGREEMENT } from '../../types/domain';
import type { Agreement } from '../../detect/ai-agreement';

function toPercent(ratio: number): string {
  return `${String(Math.round(ratio * 100))}%`;
}

const TARGET = toPercent(AI_HINT_TARGET_AGREEMENT);

/**
 * いまの線引きでの一致率の 1 文。
 *
 * **30 件に届くまでは達成 / 未達を言わない**（judgeAgreement）。% は出すが、
 * 判定の言葉を添えないことで、数件で線引きを動かさないようにする。
 */
export function describeAgreementSummary(agreement: Agreement): string {
  if (agreement.ratio === null) {
    return 'まだ回答がありません。トレンドの「AI文体かも？」にマウスを乗せて「そうかも / 違うかも」を押すと、ここに一致率が出ます。';
  }
  const head = `いまの線引き（${String(agreement.threshold)} 点以上）: ${String(agreement.answered)} 件中 ${String(agreement.agreed)} 件が一致（${toPercent(agreement.ratio)}）。`;
  const status = judgeAgreement(agreement);
  switch (status.kind) {
    case 'pending':
      return `${head}あと ${String(status.remaining)} 件で判定します。`;
    case 'met':
      return `${head}目標の ${TARGET} に届いています。`;
    case 'unmet':
      return `${head}目標の ${TARGET} に届いていません。線引きを動かすなら、下の表で一致率の高い点数を探せます。`;
  }
}

/** 表の 1 マス。回答が無ければ「—」（0% と表示しない） */
export function describeAgreementCell(agreement: Agreement): string {
  if (agreement.ratio === null) return '—';
  return `${toPercent(agreement.ratio)}（${String(agreement.agreed)} / ${String(agreement.answered)}）`;
}

/** 旧形式の回答の注記。無ければ null（何も出さない） */
export function describeLegacy(count: number): string | null {
  if (count === 0) return null;
  return `以前のボタンで答えた ${String(count)} 件は、回答時の点数が残っていないため集計に入れていません。`;
}
