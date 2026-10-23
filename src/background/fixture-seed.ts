/**
 * fixture ビルドの storage を、スクショ用の決まった状態にする。
 *
 * **候補は `detectCandidates` の出力をそのまま保存する。**差し替えは
 * `detect/` の 1 箇所だけにしてあり（fixture.ts のヘッダー）、ここはそれを
 * スキャンの代わりに 1 回呼ぶだけ（本番の scanner が saveCandidates する位置）。
 *
 * 評価・ミュートの記録・最終スキャンは検出結果ではないので `detect/` の出力に
 * 乗らない。これらは scanner やポップアップが storage に書くものなので、
 * **同じ置き場（storage）に fixture の値を置く。**UI 層には手を入れない。
 */
import * as storage from '../lib/storage';
import { updateBadge } from '../lib/badge';
import { detectCandidates } from '../detect/detector';
import type { FixtureScene } from '../detect/fixture';

export async function seedFixture(scene: FixtureScene, now: Date): Promise<void> {
  // 設定は sync にあり、resetLocalState は触らない。スライダーの位置は撮影者が決める
  const settings = await storage.getSettings();
  const candidates = detectCandidates({}, settings, now);
  await storage.resetLocalState({
    likeIndex: {},
    candidates,
    feedback: structuredClone(scene.feedback),
    muteLog: structuredClone(scene.muteLog),
    lastScanAt: scene.scanResult.finishedAt,
    lastScanResult: structuredClone(scene.scanResult),
  });
  // ツールバーのバッジも写るので、件数を合わせる（scanner の persistScan と同じ）
  await updateBadge(candidates.length, false);
}
