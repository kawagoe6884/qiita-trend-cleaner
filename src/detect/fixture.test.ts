import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildFixtureScene, sceneCandidates, FIXTURE_SCENE } from './fixture';
import { DEFAULT_SETTINGS } from '../types/domain';

afterEach(() => {
  vi.unstubAllEnvs();
});

const scene = buildFixtureScene();

/** 画面に名前として出うる文字列をすべて集める（見出し・本文・評価・ミュートの記録） */
function everyHandle(): string[] {
  return [
    ...scene.candidates.flatMap((c) => [
      c.authorHandle,
      ...c.clusterAccounts,
      ...(c.coAuthors ?? []),
    ]),
    ...Object.keys(scene.feedback),
    ...Object.keys(scene.muteLog),
  ];
}

describe('FIXTURE_SCENE の切り替え', () => {
  it('fixture ビルド以外では null（本番にダミーを持ち込まない）', () => {
    // vitest の mode は 'test'。本番の 'production' と同じく fixture ではない
    expect(FIXTURE_SCENE).toBeNull();
  });

  it('mode が fixture のときだけ中身を持つ', async () => {
    // Arrange — 値はモジュールの読み込み時に決まるので、読み直す
    vi.stubEnv('MODE', 'fixture');
    vi.resetModules();
    // Act
    const reloaded = await import('./fixture');
    // Assert
    expect(reloaded.FIXTURE_SCENE).toEqual(buildFixtureScene());
  });
});

describe('fixture の名前と ID', () => {
  it('アカウント名はすべて demo- で始まる実在しえない形', () => {
    for (const handle of everyHandle()) {
      expect(handle).toMatch(/^demo-(author-\d+|member-[a-z])$/);
    }
  });

  it('記事 ID は Qiita の記事 ID（16 進 20 桁）と衝突しない', () => {
    for (const itemId of scene.candidates.flatMap((c) => c.sharedItemIds)) {
      expect(itemId).toMatch(/^demo-item-\d+$/);
      expect(itemId).not.toMatch(/^[0-9a-f]{20}$/);
    }
  });

  it('著者間の共起の相手は、同じ fixture の候補', () => {
    const authors = new Set(scene.candidates.map((c) => c.authorHandle));
    const coAuthors = scene.candidates.flatMap((c) => c.coAuthors ?? []);
    expect(coAuthors.length).toBeGreaterThan(0);
    for (const coAuthor of coAuthors) expect(authors).toContain(coAuthor);
  });
});

describe('fixture の中身は機能の説明として成立する', () => {
  it('候補は 3〜4 件', () => {
    expect(scene.candidates.length).toBeGreaterThanOrEqual(3);
    expect(scene.candidates.length).toBeLessThanOrEqual(4);
  });

  it('空の状態を含まない（「測れません」「まだいません」を写さない）', () => {
    for (const candidate of scene.candidates) {
      expect(candidate.windowShare).not.toBeNull();
      expect(candidate.windowShare?.total).toBeGreaterThan(0);
      expect(candidate.windowShare?.cluster).toBeGreaterThan(0);
    }
  });

  it('既定の閾値をはっきり超え、母数も小さくない', () => {
    for (const candidate of scene.candidates) {
      expect(candidate.clusterSize).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.minClusterSize + 3);
      expect(candidate.sharedItemCount).toBeGreaterThan(DEFAULT_SETTINGS.minSharedItems);
      const share = candidate.windowShare;
      if (share === null) throw new Error('windowShare is null');
      // 1/2 (50%) のような小さい母数を避ける
      expect(share.total).toBeGreaterThanOrEqual(5);
      expect(share.cluster / share.total).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('数字どうしが矛盾しない（本番の検出が作りえない組み合わせを写さない）', () => {
    for (const candidate of scene.candidates) {
      expect(candidate.clusterSize).toBe(candidate.clusterAccounts.length);
      expect(candidate.sharedItemCount).toBe(candidate.sharedItemIds.length);
      // 窓内のクラスタのアカウント数は clusterSize 以下（WindowShare の JSDoc）
      expect(candidate.windowShare?.cluster).toBeLessThanOrEqual(candidate.clusterSize);
    }
  });

  it('detectCandidates と同じ並び（clusterSize の降順）', () => {
    const sizes = scene.candidates.map((c) => c.clusterSize);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it('評価前 / 評価済み（妥当）/ ミュート済みが 1 件ずつ以上ある', () => {
    const handles = scene.candidates.map((c) => c.authorHandle);
    const unjudged = handles.filter((h) => scene.feedback[h] === undefined);
    const muted = handles.filter((h) => scene.muteLog[h]?.mutedAt !== undefined);
    const validOnly = handles.filter(
      (h) => scene.feedback[h] === 'valid' && scene.muteLog[h] === undefined,
    );
    expect(unjudged.length).toBeGreaterThanOrEqual(1);
    expect(validOnly.length).toBeGreaterThanOrEqual(1);
    expect(muted.length).toBeGreaterThanOrEqual(1);
    // ミュート済みは「妥当」と同時にミュートした流れ。評価の無いミュートは作らない
    for (const handle of muted) expect(scene.feedback[handle]).toBe('valid');
  });

  it('最終スキャン日時は固定（撮り直しても同じ画面）', () => {
    expect(buildFixtureScene().scanResult.finishedAt).toBe(scene.scanResult.finishedAt);
    expect(Number.isNaN(Date.parse(scene.scanResult.finishedAt))).toBe(false);
  });
});

describe('sceneCandidates', () => {
  it('複製を返す。書き換えても次の呼び出しに漏れない', () => {
    // Arrange
    const first = sceneCandidates(scene);
    // Act
    first[0]?.clusterAccounts.push('mutated');
    first.reverse();
    // Assert
    expect(sceneCandidates(scene)).toEqual(buildFixtureScene().candidates);
  });
});
