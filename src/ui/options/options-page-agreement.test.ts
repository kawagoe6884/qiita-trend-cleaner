import { describe, it, expect, vi, beforeEach } from 'vitest';
import { init } from './options-page';
import { loadState } from './token-form';
import { logger } from '../../lib/logger';
import { AI_SIGNALS } from '../../types/domain';
import { setupDom, el } from '../../test/options-page-dom';
import type * as TokenForm from './token-form';

/**
 * 設定画面の「AI文体かも？」の一致率（M3）。
 * options-page.test.ts が 800 行を大きく超えたので分けた（コードレビュー LOW）。
 */
vi.mock('./token-form', async (importOriginal) => {
  const actual = await importOriginal<typeof TokenForm>();
  return { ...actual, loadState: vi.fn() };
});

beforeEach(() => {
  vi.clearAllMocks();
  setupDom();
  vi.mocked(loadState).mockResolvedValue({ kind: 'light' });
});

/** M3: 「そうかも / 違うかも」と目安の一致率 */
describe('「AI文体かも？」の一致率', () => {
  const at = '2026-10-24T00:00:00.000Z';

  /** 合成の回答。記事 ID は連番 */
  function answersOf(...entries: ['yes' | 'no', number | null][]): Record<string, unknown> {
    return Object.fromEntries(
      entries.map(([verdict, score], index) => [
        `item-${String(index)}`,
        score === null ? verdict : { verdict, score, fired: [], answeredAt: at },
      ]),
    );
  }

  function rows(): HTMLTableRowElement[] {
    return [...document.querySelectorAll<HTMLTableRowElement>('#ai-agreement-rows tr')];
  }

  function currentRow(): HTMLTableRowElement | undefined {
    return rows().find((row) => row.getAttribute('aria-current') === 'true');
  }

  function storageListener() {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)?.[0];
    if (!listener) throw new Error('storage listener not registered');
    return listener;
  }

  it('回答が無ければ、答え方を案内する', async () => {
    await init();
    expect(el('#ai-agreement-summary').textContent).toContain('まだ回答がありません');
  });

  it('いまの線引きでの一致率を出す', async () => {
    // Arrange — 線引き 5: 6 点「そうかも」= 一致、2 点「そうかも」= 不一致
    await chrome.storage.local.set({ aiVerdicts: answersOf(['yes', 6], ['yes', 2]) });
    // Act
    await init();
    // Assert
    expect(el('#ai-agreement-summary').textContent).toBe(
      'いまの基準（5 点以上）: 2 件中 1 件が一致（50%）。あと 28 件で判定します。',
    );
  });

  it('1〜8 点それぞれの一致率を表にし、いまの線引きの行を示す', async () => {
    // Arrange
    await chrome.storage.local.set({
      aiVerdicts: answersOf(['yes', 6], ['yes', 2]),
      aiHintPrefs: { threshold: 2, minProseChars: 334 },
    });
    // Act
    await init();
    // Assert
    expect(rows()).toHaveLength(AI_SIGNALS.length);
    expect(rows()[0]?.textContent).toContain('1 点以上');
    // 線引き 2 なら両方とも強調 → 両方「そうかも」なので 100%
    expect(currentRow()?.textContent).toContain('2 点以上');
    expect(currentRow()?.textContent).toContain('100%（2 / 2）');
  });

  it('スライダーを動かすと、保存を待たずに一致率と表の印が追従する', async () => {
    // Arrange
    await chrome.storage.local.set({ aiVerdicts: answersOf(['yes', 6], ['yes', 2]) });
    await init();
    const slider = el<HTMLInputElement>('#ai-threshold');
    // Act
    slider.value = '2';
    slider.dispatchEvent(new Event('input'));
    // Assert
    expect(el('#ai-agreement-summary').textContent).toContain(
      'いまの基準（2 点以上）: 2 件中 2 件',
    );
    expect(currentRow()?.textContent).toContain('2 点以上');
  });

  it('トレンドで答えると（storage が変わると）描き直す', async () => {
    // Arrange
    await init();
    // Act
    await chrome.storage.local.set({ aiVerdicts: answersOf(['no', 1]) });
    storageListener()({ aiVerdicts: { newValue: {} } }, 'local');
    // Assert
    await vi.waitFor(() => {
      expect(el('#ai-agreement-summary').textContent).toContain('1 件中 1 件が一致');
    });
  });

  it('旧形式の回答は集計に入れず、件数だけ注記する', async () => {
    // Arrange
    await chrome.storage.local.set({
      aiVerdicts: answersOf(['yes', null], ['no', null], ['no', 1]),
    });
    // Act
    await init();
    // Assert
    expect(el('#ai-agreement-summary').textContent).toContain('1 件中 1 件');
    const legacy = el('#ai-agreement-legacy');
    expect(legacy.hidden).toBe(false);
    expect(legacy.textContent).toContain('2 件');
  });

  it('旧形式が無ければ注記を隠す', async () => {
    await chrome.storage.local.set({ aiVerdicts: answersOf(['no', 1]) });
    await init();
    expect(el('#ai-agreement-legacy').hidden).toBe(true);
  });

  it('スライダーを動かしている途中に回答が届いても、画面に出ている線引きで描き直す', async () => {
    // Arrange — 保存済みの線引きは 5。スライダーを 2 にしたが、まだ手を離していない（input のみ）
    await chrome.storage.local.set({ aiVerdicts: answersOf(['yes', 6], ['yes', 2]) });
    await init();
    const slider = el<HTMLInputElement>('#ai-threshold');
    slider.value = '2';
    slider.dispatchEvent(new Event('input'));
    // Act — 別のタブのトレンドで回答した
    await chrome.storage.local.set({ aiVerdicts: answersOf(['yes', 6], ['yes', 2], ['yes', 3]) });
    storageListener()({ aiVerdicts: { newValue: {} } }, 'local');
    // Assert — 保存済みの 5 ではなく、画面の 2 で数える（コードレビュー LOW）
    await vi.waitFor(() => {
      expect(el('#ai-agreement-summary').textContent).toContain(
        'いまの基準（2 点以上）: 3 件中 3 件',
      );
    });
    expect(currentRow()?.textContent).toContain('2 点以上');
  });
});

/** コードレビュー M2: 表示の要素が無いとき・読み直しに失敗したときに壊れない */
describe('「AI文体かも？」の一致率 — 想定外の状況', () => {
  function storageListener() {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)?.[0];
    if (!listener) throw new Error('storage listener not registered');
    return listener;
  }

  it('一致率の要素が無いページでも、初期化もスライダーも止まらない', async () => {
    // Arrange — 要素が取れなければ何もしない（selectors.ts と同じフェイルセーフ原則）
    for (const id of ['#ai-agreement-summary', '#ai-agreement-rows', '#ai-agreement-legacy']) {
      document.querySelector(id)?.remove();
    }
    // Act
    await init();
    const slider = el<HTMLInputElement>('#ai-threshold');
    slider.value = '3';
    slider.dispatchEvent(new Event('input'));
    // Assert — 線引きの表示は動き続ける
    expect(el('#ai-threshold-value').textContent).toBe('3 / 8 点');
  });

  it('回答の読み直しに失敗しても、debug に残すだけで画面は前の表示のまま', async () => {
    // Arrange
    const debug = vi.spyOn(logger, 'debug');
    await init();
    const before = el('#ai-agreement-summary').textContent;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(new Error('storage unavailable'));
    // Act
    storageListener()({ aiVerdicts: { newValue: {} } }, 'local');
    // Assert — warn / error に上げない（Chrome のエラー欄に「拡張が壊れている」と載る）
    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith('failed to reload ai verdicts:', expect.any(Error));
    });
    expect(el('#ai-agreement-summary').textContent).toBe(before);
    debug.mockRestore();
  });
});
