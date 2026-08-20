/**
 * ツールバーのバッジ。**優先順位を 1 箇所に集める。**
 *
 * バッジは実質 4 文字しか入らない。429 の残り時間（「あと 42 分」）は入らないので
 * 記号にし、時間はポップアップで伝える。
 *
 *   429 中 > 候補件数 > 空
 *
 * Phase 7 の除外件数バッジもこの規則の上に載せる。バッジは 1 つしかないので、
 * 3 つ目の用途を足すときは必ずここで衝突を解く。
 *
 * 【scanner だけが呼ぶのでは足りない】
 * 閾値はポップアップのスライダーでも変わる。スキャン時にしか更新しないと、
 * 一覧が 5 件を出しているのにバッジは前回スキャン時の 2 件を出し続ける。
 */
import { logger } from './logger';

export function badgeText(candidateCount: number, rateLimited: boolean): string {
  if (rateLimited) return '!';
  return candidateCount > 0 ? String(candidateCount) : '';
}

export async function updateBadge(candidateCount: number, rateLimited: boolean): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: badgeText(candidateCount, rateLimited) });
  } catch (error) {
    // バッジが出ないだけで処理そのものは成立している。想定内なので debug
    logger.debug('failed to update badge:', error);
  }
}
