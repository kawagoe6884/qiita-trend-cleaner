/**
 * 「AI文体かも？」の目安と、利用者の答え（そうかも / 違うかも）の一致率を数える。
 *
 * この層は純粋関数である（storage も DOM も触らない）。表示は設定画面の責務。
 *
 * 【一致の定義】（M3 Plan D3）
 * 線引き t での予測「点数 >= t（強調する）」と、答え「そうかも」が同じなら一致。
 * 答えは強調の有無に関係なく「利用者が AI 文体だと思うか」なので、
 * 回答時の点数さえあれば、どの線引きの一致率も同じ回答から計算できる。
 *
 * 【数えないもの】
 * 点数の無い旧形式の回答（M3 より前）。件数は countLegacyAnswers で別に出す。
 */
import {
  AI_HINT_TARGET_AGREEMENT,
  AI_HINT_TARGET_ANSWERS,
  AI_HINT_THRESHOLD_RANGE,
} from '../types/domain';
import type { AiVerdictLog } from '../types/domain';

/** ある線引きでの一致率 */
export interface Agreement {
  threshold: number;
  /** 数えた回答の数（旧形式を除く） */
  answered: number;
  agreed: number;
  /** 一致数 ÷ 回答数。**回答が 0 件なら null**（0% と表示しない — precisionOf と同じ） */
  ratio: number | null;
}

/** 線引き t での一致率 */
export function agreementAt(log: AiVerdictLog, threshold: number): Agreement {
  let answered = 0;
  let agreed = 0;
  for (const { verdict, score } of Object.values(log)) {
    if (score === null) continue;
    answered += 1;
    if (score >= threshold === (verdict === 'yes')) agreed += 1;
  }
  return { threshold, answered, agreed, ratio: answered === 0 ? null : agreed / answered };
}

/** 線引きの全範囲（AI_HINT_THRESHOLD_RANGE）それぞれの一致率。小さい順 */
export function agreementByThreshold(log: AiVerdictLog): Agreement[] {
  const rows: Agreement[] = [];
  for (let t = AI_HINT_THRESHOLD_RANGE.min; t <= AI_HINT_THRESHOLD_RANGE.max; t += 1) {
    rows.push(agreementAt(log, t));
  }
  return rows;
}

/** 点数の無い旧形式の回答の数。集計には入れないが、件数は見せる */
export function countLegacyAnswers(log: AiVerdictLog): number {
  return Object.values(log).filter((entry) => entry.score === null).length;
}

/**
 * 目標の判定で許す浮動小数の誤差。**目標値を変えたときの備え。**
 *
 * 回答数 × 目標は浮動小数の掛け算で、整数をわずかに超えることがある
 * （例: 100 × 0.07 = 7.000000000000001 で、ちょうど 7% が未達に落ちる）。
 * 0.7 では 1〜5000 件で起きないことを確かめたが、目標は定数 1 つで変えられる。
 * 回答数は高々数千なので、この幅で別の件数を取り違えることはない
 */
const FLOAT_TOLERANCE = 1e-9;

/** 目標に照らした判定 */
export type AgreementStatus =
  { kind: 'pending'; remaining: number } | { kind: 'met' } | { kind: 'unmet' };

/**
 * 目標（30 件で 70%）に照らして判定する。
 *
 * **30 件に届くまでは判定しない。**分母が小さいうちの % は揺れが大きく、
 * 数件で「達成」「未達」を出すと線引きを早まって動かす原因になる。
 */
export function judgeAgreement(agreement: Agreement): AgreementStatus {
  if (agreement.answered < AI_HINT_TARGET_ANSWERS) {
    return { kind: 'pending', remaining: AI_HINT_TARGET_ANSWERS - agreement.answered };
  }
  // 割り算ではなく掛け算で比べ、さらに浮動小数の誤差ぶんだけ甘くする
  const met = agreement.agreed >= agreement.answered * AI_HINT_TARGET_AGREEMENT - FLOAT_TOLERANCE;
  return met ? { kind: 'met' } : { kind: 'unmet' };
}
