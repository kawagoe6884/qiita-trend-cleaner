/**
 * 記事本文（Markdown）の文体から「AI文体かも？」の目安を数える。
 *
 * この層は純粋関数である（storage も fetch も触らない）。detector.ts と同じく、
 * 保存とログは scanner.ts の責務。**モードでも分岐しない。**
 *
 * 【何を根拠にしているか】
 * 「Qiita の文章は生成 AI 以前と以後でどう変わったか」
 * （https://nyosegawa.com/posts/qiita-writing-before-after-ai/）の公表値。
 * 2019〜2022 年（AI 以前）と 2026 年の値の**中点**を各シグナルの境目にする（Plan D1/D2）。
 *
 * ⚠️ 元の分析は**集団の傾向**で、記事単位の判定器ではない。同記事自身が
 * 「AI が書いた文章の増加」と「人間の書き方の変化」を区別できないと書いている。
 * ここで数えた点数は「AI 記事である」根拠ではなく、開く前の目安にすぎない
 * （「断定はしません」の約束は AI 判定にも及ぶ）。
 *
 * 【正規表現で地の文を抜く理由】
 * Markdown パーサを依存に足すと、配布物が膨らむうえに Qiita 独自記法
 * （`:::note`、` ```js:file `）の扱いを別に覚える必要がある。崩れたときは
 * **除外する側に倒す**（コードを地の文として数えるより、地の文を落とす方が無害）。
 */
import { RETENTION_DAYS } from './like-index';
import { AI_HINT_DEFAULT_THRESHOLD, AI_HINT_MIN_PROSE_CHARS, AI_SIGNALS } from '../types/domain';
import type { AiHint, AiHintLog, AiSignal } from '../types/domain';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 各シグナルの境目。値と出典を 1 箇所に置く。
 *
 * | シグナル | AI 以前 | 2026 年 | 境目 |
 * |---|---|---|---|
 * | 1 文あたり読点 | 0.63 | 0.95 | 0.79 を超える |
 * | 太字 / 1000 字 | 1.26 | 3.83 | 2.5 を超える |
 * | 箇条書きの割合 | 8.9% | 16.4% | 12.5% を超える |
 * | 地の文の文字数 | 976 | 1,914 | 1,445 以上 |
 *
 * 箇条書きの割合は、元記事の定義（行か文字か）が読み取れないため**行の割合**で数える。
 * ダッシュは「約 10 倍」としか書かれておらず絶対値が無いため、AI 以前に
 * まれだったことを根拠に **1 つでもあれば**立てる。
 */
export const AI_STYLE_BOUNDS = {
  commasPerSentence: 0.79,
  boldPer1000Chars: 2.5,
  bulletLineRatio: 0.125,
  longProseChars: 1445,
} as const;

/**
 * 生成 AI 以後に広がった語。「効く」は活用形も拾う。
 * 元記事の例示のうち、技術記事の通常語と衝突しにくいものに絞っている。
 */
const RISING_WORDS = /効[いかきくけこ]|既定|実測|入口|事故|別物/;

/**
 * 生成 AI 以後に減った表現。どれか 1 つでもあれば「使っている」。
 * 元記事は「しましょう」だが、「試してみましょう」のような呼びかけも同じ文体なので
 * 「ましょう」で拾う
 */
const FALLING_EXPRESSIONS = /ましょう|[！!]|また、/;

/** 全角ダッシュ（U+2014）と水平線（U+2015） */
const DASH = /[—―]/;

/** 読点。全角カンマも数える */
const COMMA = /[、，]/g;

/** 文の終わり。改行も区切りとして扱う（箇条書きは句点で終わらないことが多い） */
const SENTENCE_END = /[。！？!?\n]/;

/** 地の文を抜き出した結果。テストのために公開する */
export interface Prose {
  /** 地の文の行（記号を除き trim 済み、空行なし） */
  lines: string[];
  /** 見出しの文字列（# を除く） */
  headings: string[];
  /** 箇条書きだった行の数 */
  bulletLines: number;
  /** 太字の数 */
  boldCount: number;
}

/** フェンスの開始・終了。` ```js:index.js ` のような Qiita のファイル名付きも含む */
const FENCE = /^\s*(```|~~~)/;

/** 1 行を地の文として整える。消えたら空文字を返す */
function cleanLine(line: string): string {
  return (
    line
      // 画像は丸ごと消す（! を感嘆符として数えないため、リンクより先に処理する）
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      // リンクは文字だけ残す
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`[^`]*`/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/<[^>]+>/g, '')
      // 入れ子（`<scr<script>ipt>`）は 1 回の置換では「<script」が残る。数えるだけで
      // 表示には使わないが、残った < > も消して結果に HTML の断片を持たせない（CodeQL）
      .replace(/[<>]/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .trim()
  );
}

/** 1 行の中の太字の数 */
function countBold(line: string): number {
  return (line.match(/\*\*[^*]+\*\*|__[^_]+__/g) ?? []).length;
}

/**
 * Markdown から地の文を抜き出す。
 *
 * 除くもの: コードブロック・インラインコード・表・引用・画像・URL・HTML タグ・
 * 水平線・`:::` の囲み記号。見出しは地の文に含めず別に持つ。
 */
export function extractProse(markdown: string): Prose {
  const lines: string[] = [];
  const headings: string[] = [];
  let bulletLines = 0;
  let boldCount = 0;
  let inFence = false;

  for (const raw of markdown.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('|') || trimmed.startsWith('>')) continue;
    if (trimmed.startsWith(':::')) continue;
    if (/^([-*_])\1{2,}$/.test(trimmed)) continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) {
      headings.push(cleanLine(heading[1] ?? ''));
      continue;
    }

    const bullet = /^(?:[-*+]|\d+\.)\s+(.*)$/.exec(trimmed);
    const body = bullet ? (bullet[1] ?? '') : trimmed;

    boldCount += countBold(body);
    const cleaned = cleanLine(body);
    if (cleaned === '') continue;
    if (bullet) bulletLines += 1;
    lines.push(cleaned);
  }

  return { lines, headings, bulletLines, boldCount };
}

/** 空白（全角を含む）を除いた文字数 */
function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

/** 記事 1 件の文体スコア（scoredAt は呼び出し側が付ける） */
export type AiStyleScore = Pick<AiHint, 'fired' | 'proseChars'>;

/**
 * 本文を数えてシグナルを立てる。
 *
 * 本文は**ここで使い捨てる**。戻り値に本文や語を含めない（Plan D5）。
 */
export function scoreAiStyle(markdown: string): AiStyleScore {
  const prose = extractProse(markdown);
  const text = prose.lines.join('\n');
  const proseChars = countChars(text);

  const sentences = text.split(SENTENCE_END).filter((sentence) => sentence.trim() !== '');
  const commas = (text.match(COMMA) ?? []).length;

  const raised = new Set<AiSignal>();
  if (sentences.length > 0 && commas / sentences.length > AI_STYLE_BOUNDS.commasPerSentence) {
    raised.add('commaDensity');
  }
  if (proseChars > 0 && (prose.boldCount / proseChars) * 1000 > AI_STYLE_BOUNDS.boldPer1000Chars) {
    raised.add('boldDensity');
  }
  if (
    prose.lines.length > 0 &&
    prose.bulletLines / prose.lines.length > AI_STYLE_BOUNDS.bulletLineRatio
  ) {
    raised.add('bulletRatio');
  }
  if (DASH.test(text)) raised.add('dash');
  if (prose.headings.some((heading) => heading.includes('まとめ'))) raised.add('summaryHeading');
  if (RISING_WORDS.test(text)) raised.add('risingWords');
  // 地の文が無い記事で「使わない」を立てると、コードだけの記事に 1 点入る
  if (proseChars > 0 && !FALLING_EXPRESSIONS.test(text)) raised.add('noFallingExpressions');
  if (proseChars >= AI_STYLE_BOUNDS.longProseChars) raised.add('longProse');

  return { fired: AI_SIGNALS.filter((signal) => raised.has(signal)), proseChars };
}

/** 地の文が短く、判定が甘い可能性がある */
export function isShortProse(hint: AiHint): boolean {
  return hint.proseChars < AI_HINT_MIN_PROSE_CHARS;
}

/** 「AI文体かも？」を強調するか。閾値は M2 で利用者が動かせるようにする */
export function isAiLikely(hint: AiHint, threshold: number = AI_HINT_DEFAULT_THRESHOLD): boolean {
  return hint.fired.length >= threshold;
}

/**
 * 保持期間（RETENTION_DAYS）を過ぎたスコアを捨てる。引数は書き換えない。
 *
 * いいねの蓄積と同じ期間にそろえる。7 日を超えてトレンドに残る記事は
 * 本文を取り直すことになるが、その間に本文が直されていれば新しい方が正しい。
 */
export function purgeAiHints(log: AiHintLog, now: Date): AiHintLog {
  const cutoffMs = now.getTime() - RETENTION_DAYS * MS_PER_DAY;
  const kept: AiHintLog = {};
  for (const [itemId, hint] of Object.entries(log)) {
    const scoredMs = Date.parse(hint.scoredAt);
    if (Number.isFinite(scoredMs) && scoredMs >= cutoffMs) kept[itemId] = hint;
  }
  return kept;
}
