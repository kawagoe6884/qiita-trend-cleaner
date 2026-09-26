import { describe, it, expect, vi, beforeEach } from 'vitest';
import { init, APPLY_DEBOUNCE_MS } from './popup-page';
import { loadPopupState, applySettings, recordVerdict, toViews } from './popup-state';
import type * as PopupState from './popup-state';
import { DEFAULT_SETTINGS } from '../../types/domain';
import type { Candidate } from '../../types/domain';
// 実際に配布される HTML をそのまま読む（Vite の ?raw）。
// node:fs を使うと tsconfig の types に node を足すことになり、
// 拡張のコードから node API が見えてしまう guardrail を失う
import indexHtml from './index.html?raw';

vi.mock('./popup-state', async (importOriginal) => {
  const actual = await importOriginal<typeof PopupState>();
  return {
    ...actual,
    loadPopupState: vi.fn(),
    applySettings: vi.fn(),
    recordVerdict: vi.fn(),
  };
});

const loadMock = vi.mocked(loadPopupState);
const applyMock = vi.mocked(applySettings);
const verdictMock = vi.mocked(recordVerdict);

const SETTINGS = { ...DEFAULT_SETTINGS, minClusterSize: 5, minSharedItems: 2, lookbackDays: 3 };
const NO_PRECISION = { valid: 0, falsePositive: 0, ratio: null };

/**
 * 蓄積の著者の内訳。**モード説明以外のテストでは値そのものに意味は無い**が、
 * 蓄積があることになっている状態（hasIndex: true）と辻褄を合わせておく。
 * 0 人にすると「蓄積はあるのに著者が 1 人も居ない」という実機に無い形になる。
 */
const COVERAGE = { total: 3, solo: 2 };

/** 合成の候補。実アカウント名・実 item_id は使わない */
function candidate(handle = 'example-author-a'): Candidate {
  return {
    authorHandle: handle,
    clusterAccounts: ['example-liker-1', 'example-liker-2'],
    sharedItemCount: 2,
    sharedItemIds: ['0123456789abcdef0001', '0123456789abcdef0002'],
    clusterSize: 9,
    burstScore: 0.5,
    emptyAccountRatio: 0.25,
    // 窓内のいいね 5 件中 4 件 = 80%。burstScore(0.5) と別の値にしてある
    windowShare: { cluster: 4, total: 5 },
    detectedAt: '2026-08-20T03:00:00.000Z',
  };
}

/** index.html と同じ骨格。id と hidden の扱いを実物に合わせる */
function setupDom(): void {
  document.body.innerHTML = `
    <p id="notice" hidden></p>
    <section class="mode">
      <p id="mode-title"></p>
      <p id="mode-detail"></p>
      <button type="button" id="open-options">トークンを設定する</button>
    </section>
    <p id="summary">読み込み中…</p>
    <p id="call" hidden></p>
    <p id="last-scan"></p>
    <p class="footnote" id="mute-note">
      ミュートは <a href="https://qiita.com/settings/mutes">ミュート設定</a>
      から一覧・解除ができます。表示や動作は
      <button type="button" class="link-button" id="open-settings">拡張機能の設定</button>
      から変えられます。
    </p>
    <details id="conditions">
      <summary id="conditions-summary">判定の条件</summary>
      <p class="slider">
        <label for="min-cluster">何アカウントそろったら</label>
        <input type="range" id="min-cluster" min="2" max="30" step="1" />
        <output id="min-cluster-value"></output>
      </p>
      <p class="slider">
        <input type="range" id="min-shared" min="2" max="10" step="1" />
        <output id="min-shared-value"></output>
      </p>
      <p class="slider">
        <input type="range" id="lookback" min="1" max="7" step="1" />
        <output id="lookback-value"></output>
      </p>
      <p class="slider">
        <input type="range" id="burst-window" min="0" max="6" step="1" />
        <output id="burst-window-value"></output>
      </p>
    </details>
    <ul id="candidates"></ul>
    <p id="empty" hidden>いまの条件に当てはまる候補はありません。</p>
    <details id="folded" hidden>
      <summary id="folded-summary"></summary>
      <p class="footnote" id="fold-note" hidden>
        ここで「誤り」を押しても、Qiita 側のミュートは解除されません。解除は
        <a href="https://qiita.com/settings/mutes">ミュート設定</a> から行ってください。
      </p>
      <ul id="folded-candidates"></ul>
    </details>`;
}

/** chrome.tabs.Tab の全項目は要らない。query が返す最小形だけ用意する */
function tab(id: number, url: string, active = false): chrome.tabs.Tab {
  return { id, url, active } as unknown as chrome.tabs.Tab;
}

function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

/** 「妥当」ボタンを押す */
function clickVerdict(label: string): void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#candidates button')];
  const target = buttons.find((button) => button.textContent === label);
  if (!target) throw new Error(`missing button: ${label}`);
  target.click();
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDom();
  loadMock.mockResolvedValue({
    views: toViews([candidate()], {}),
    precision: NO_PRECISION,
    settings: SETTINGS,
    rateLimitNotice: null,
    lastScanAt: '2026-08-20T03:00:00.000Z',
    hasToken: false,
    hasIndex: true,
    authorCoverage: COVERAGE,
    muteOnValid: false,
    foldTarget: 'none' as const,
  });
  applyMock.mockResolvedValue(toViews([candidate()], {}));
  verdictMock.mockResolvedValue({ valid: 1, falsePositive: 0, ratio: 1 });
});

describe('init の描画', () => {
  it('候補を件数ぶん描く', async () => {
    await init();
    expect(document.querySelectorAll('#candidates li')).toHaveLength(1);
    expect(el('#summary').textContent).toContain('候補 1 件');
  });

  it('未評価なら適合率を「—」と出す（0% と区別する）', async () => {
    await init();
    expect(el('#summary').textContent).toContain('適合率 — (未評価)');
  });

  it('評価済みなら百分率を出す', async () => {
    loadMock.mockResolvedValue({
      views: toViews([candidate()], { 'example-author-a': 'valid' }),
      precision: { valid: 3, falsePositive: 1, ratio: 0.75 },
      settings: SETTINGS,
      rateLimitNotice: null,
      lastScanAt: null,
      hasToken: false,
      hasIndex: true,
      authorCoverage: COVERAGE,
      muteOnValid: false,
      foldTarget: 'none' as const,
    });
    await init();
    expect(el('#summary').textContent).toContain('適合率 75%');
  });

  it('トークン未設定ならライトモードと、設定する理由を出す', async () => {
    // Arrange — 裸のボタンだけでは「なぜ設定するのか」が分からない
    await init();
    // Assert
    expect(el('#mode-title').textContent).toBe('ライトモードで動作中');
    expect(el('#mode-detail').textContent).toContain('著者の過去記事');
    expect(el('#mode-detail').textContent).toContain('60 → 1000');
    expect(el('#open-options').textContent).toBe('トークンを設定する');
    // 蓄積の実数が状態から文言まで届いていること。**ここを見ないと、
    // renderMode に空の内訳を渡す変更が誰にも捕まらない**
    expect(el('#mode-detail').textContent).toContain(
      `${String(COVERAGE.total)} 人の著者のうち ${String(COVERAGE.solo)} 人`,
    );
  });

  it('トークン設定済みならフルモードと表示し、ボタンの文言も変える', async () => {
    // Arrange
    loadMock.mockResolvedValue({
      views: [],
      precision: NO_PRECISION,
      settings: SETTINGS,
      rateLimitNotice: null,
      lastScanAt: null,
      hasToken: true,
      hasIndex: true,
      authorCoverage: COVERAGE,
      muteOnValid: false,
      foldTarget: 'none' as const,
    });
    // Act
    await init();
    // Assert
    expect(el('#mode-title').textContent).toBe('フルモードで動作中');
    expect(el('#open-options').textContent).toBe('トークンを変更する');
  });

  it('最終スキャンを JST で出す', async () => {
    // Arrange — フィクスチャは UTC 03:00
    await init();
    // Act & Assert — JST は 12:00
    expect(el('#last-scan').textContent).toBe('最終スキャン 2026/08/20 12:00');
  });

  it('候補ゼロでも例外を投げず案内を出す', async () => {
    loadMock.mockResolvedValue({
      views: [],
      precision: NO_PRECISION,
      settings: SETTINGS,
      rateLimitNotice: null,
      lastScanAt: null,
      hasToken: false,
      hasIndex: true,
      authorCoverage: COVERAGE,
      muteOnValid: false,
      foldTarget: 'none' as const,
    });
    await expect(init()).resolves.toBeUndefined();
    expect(el('#empty').hidden).toBe(false);
    expect(el('#last-scan').textContent).toBe('まだスキャンしていません');
  });

  it('根拠記事のリンクを新しいタブで開く形にする', async () => {
    await init();
    const links = [...document.querySelectorAll<HTMLAnchorElement>('#candidates a')];
    expect(links).toHaveLength(2);
    expect(links[0]?.href).toBe('https://qiita.com/example-author-a/items/0123456789abcdef0001');
    expect(links[0]?.target).toBe('_blank');
    expect(links[0]?.rel).toBe('noreferrer');
  });

  it('スライダーに保存済みの値を反映する', async () => {
    await init();
    expect(el<HTMLInputElement>('#min-cluster').value).toBe('5');
    expect(el('#min-cluster-value').textContent).toBe('5');
  });

  it('429 中は案内を出す', async () => {
    loadMock.mockResolvedValue({
      views: [],
      precision: NO_PRECISION,
      settings: SETTINGS,
      rateLimitNotice: 'あと 42 分で再開できます。',
      lastScanAt: null,
      hasToken: false,
      hasIndex: true,
      authorCoverage: COVERAGE,
      muteOnValid: false,
      foldTarget: 'none' as const,
    });
    await init();
    expect(el('#notice').hidden).toBe(false);
    expect(el('#notice').textContent).toContain('42 分');
  });

  it('429 でなければ案内を隠す', async () => {
    await init();
    expect(el('#notice').hidden).toBe(true);
  });

  it('読み込みに失敗してもリスナーは付く', async () => {
    // Arrange — storage が落ちた状況
    loadMock.mockRejectedValue(new Error('boom'));
    // Act
    await init();
    // Assert — 例外にせず、スライダーは動く
    expect(el('#summary').textContent).toContain('読み込みに失敗しました');
    el<HTMLInputElement>('#min-cluster').dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(applyMock).toHaveBeenCalled();
    });
  });
});

/**
 * 著者ハンドルは Qiita 由来の外部データ。innerHTML に入れると
 * Phase 7 で XSS を再評価する前に穴ができる。
 */
describe('init の XSS 対策', () => {
  it('ハンドルをタグとして解釈しない', async () => {
    // Arrange
    const evil = '<img src=x onerror=alert(1)>';
    loadMock.mockResolvedValue({
      views: toViews([candidate(evil)], {}),
      precision: NO_PRECISION,
      settings: SETTINGS,
      rateLimitNotice: null,
      lastScanAt: null,
      hasToken: false,
      hasIndex: true,
      authorCoverage: COVERAGE,
      muteOnValid: false,
      foldTarget: 'none' as const,
    });
    // Act
    await init();
    // Assert — テキストとして出て、img 要素は生まれない
    expect(el('.author').textContent).toBe(evil);
    expect(document.querySelectorAll('#candidates img')).toHaveLength(0);
  });
});

describe('init の操作', () => {
  it('「妥当」を押すと判定を保存し、適合率を更新する', async () => {
    await init();
    clickVerdict('妥当');
    await vi.waitFor(() => {
      expect(verdictMock).toHaveBeenCalledWith('example-author-a', 'valid');
    });
    await vi.waitFor(() => {
      expect(el('#summary').textContent).toContain('適合率 100%');
    });
  });

  it('判定の記録では再検出しない（storage 全体を読み直さない）', async () => {
    // Arrange
    await init();
    applyMock.mockClear();
    // Act
    clickVerdict('妥当');
    // handleVerdict が最後まで走るのを待つ。**verdictMock の呼び出しでは足りない** —
    // 即座に解決するので、requestMute の await 連鎖が始まる前にアサートしてしまう。
    // 再描画は handleVerdict の末尾なので、ここまで来れば全部終わっている
    await vi.waitFor(() => {
      expect(document.querySelector('#candidates button[aria-pressed="true"]')).not.toBeNull();
    });
    // Assert — 閾値は変わっていないので検出をやり直す理由が無い
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('「誤り」を押すと false_positive で保存する', async () => {
    await init();
    clickVerdict('誤り');
    await vi.waitFor(() => {
      expect(verdictMock).toHaveBeenCalledWith('example-author-a', 'false_positive');
    });
  });

  it('保存中の 2 度押しは無視する', async () => {
    // Arrange — 保存を止めておく
    let release = (): void => undefined;
    verdictMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ valid: 1, falsePositive: 0, ratio: 1 });
          };
        }),
    );
    await init();
    // Act
    clickVerdict('妥当');
    clickVerdict('誤り');
    release();
    // Assert — 後から解決した側が古い適合率を描かないように
    await vi.waitFor(() => {
      expect(verdictMock).toHaveBeenCalledTimes(1);
    });
  });

  it('再描画したあともボタンが効く（イベント委譲）', async () => {
    // Arrange — 候補の要素は再検出のたびに作り直される
    await init();
    el<HTMLInputElement>('#min-cluster').value = '8';
    el<HTMLInputElement>('#min-cluster').dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(applyMock).toHaveBeenCalled();
    });
    // Act — 作り直された要素をクリックする
    clickVerdict('妥当');
    // Assert — 個々のボタンに付けたリスナーはここで消えている
    await vi.waitFor(() => {
      expect(verdictMock).toHaveBeenCalledWith('example-author-a', 'valid');
    });
  });

  it('ドラッグ中（input）は再検出も保存もしない', async () => {
    // Arrange — input は 1 px 動かすたびに発火する
    await init();
    const slider = el<HTMLInputElement>('#min-cluster');
    applyMock.mockClear();
    // Act — ドラッグを再現する
    for (const value of ['6', '7', '8', '9', '10']) {
      slider.value = value;
      slider.dispatchEvent(new Event('input'));
    }
    // Assert — ここで storage 全体の読み込みと 300 アカウントの検出が走ると、
    // 描画スレッドが飽和してつまみがドラッグに追従しなくなる
    expect(applyMock).not.toHaveBeenCalled();
    // 数字の表示だけは即座に追従する
    expect(el('#min-cluster-value').textContent).toBe('10');
  });
  it('スライダーの change で保存する', async () => {
    await init();
    const slider = el<HTMLInputElement>('#lookback');
    slider.value = '7';
    slider.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(applyMock).toHaveBeenCalledWith(
        expect.objectContaining({ lookbackDays: 7 }),
        expect.any(Date),
      );
    });
  });

  it('スライダーの値表示を更新する', async () => {
    await init();
    const slider = el<HTMLInputElement>('#min-shared');
    slider.value = '4';
    slider.dispatchEvent(new Event('input'));
    await vi.waitFor(() => {
      expect(el('#min-shared-value').textContent).toBe('4');
    });
  });

  it('「トークンを設定する」で options ページを開く', async () => {
    await init();
    el<HTMLButtonElement>('#open-options').click();
    expect(vi.mocked(chrome.runtime.openOptionsPage)).toHaveBeenCalled();
  });
});

/**
 * ドラッグ中は候補一覧が作り直され、件数によって高さが変わる。
 * 条件が一覧より **下** にあると、つまみが指の下から動いてスライドできない。
 * 実際に配布される index.html に対して順序を固定する（骨格のモックではなく）。
 */
describe('index.html のレイアウト順序', () => {
  it('判定の条件が候補一覧より前にある', () => {
    // Arrange
    // Act
    const conditions = indexHtml.indexOf('id="conditions"');
    const list = indexHtml.indexOf('id="candidates"');
    // Assert
    expect(conditions).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(-1);
    expect(conditions).toBeLessThan(list);
  });

  it('条件は既定で折りたたまれている（日常は候補を見るだけ）', () => {
    // details に open が付いていないこと
    expect(indexHtml).toContain('<details id="conditions">');
    expect(indexHtml).not.toContain('<details id="conditions" open');
  });

  it('トークンの案内が候補一覧より前にある', () => {
    // 下に置くと、429 に当たってから初めて存在に気づくことになる
    const mode = indexHtml.indexOf('id="mode-title"');
    const button = indexHtml.indexOf('id="open-options"');
    const list = indexHtml.indexOf('id="candidates"');
    expect(mode).toBeGreaterThan(-1);
    expect(mode).toBeLessThan(list);
    expect(button).toBeLessThan(list);
  });

  it('候補一覧に内側のスクロールを作らない（ポップアップ全体で 1 本）', () => {
    // 入れ子のスクロールは、どちらが動くのか分からなくなる
    const list = indexHtml.slice(
      indexHtml.indexOf('#candidates {'),
      indexHtml.indexOf('#candidates li'),
    );
    expect(list).not.toContain('overflow');
    expect(list).not.toContain('max-height');
  });
});

describe('判定の条件の見出し', () => {
  it('折りたたんだままでも現在の条件が読める', async () => {
    await init();
    expect(el('#conditions-summary').textContent).toBe(
      '判定の条件 (5 アカウントが 2 記事に共通 / 直近 3 日)',
    );
  });

  it('スライダーを動かすと見出しも追従する', async () => {
    await init();
    const slider = el<HTMLInputElement>('#min-cluster');
    slider.value = '12';
    slider.dispatchEvent(new Event('input'));
    expect(el('#conditions-summary').textContent).toContain('12 アカウント');
  });
});

describe('候補一覧への一言', () => {
  it('未評価なら押してほしいことを出す', async () => {
    await init();
    expect(el('#call').hidden).toBe(false);
    expect(el('#call').textContent).toContain('この検出が当たっているか');
  });

  it('候補ゼロなら一言を隠す', async () => {
    loadMock.mockResolvedValue({
      views: [],
      precision: NO_PRECISION,
      settings: SETTINGS,
      rateLimitNotice: null,
      lastScanAt: null,
      hasToken: false,
      hasIndex: true,
      authorCoverage: COVERAGE,
      muteOnValid: false,
      foldTarget: 'none' as const,
    });
    await init();
    expect(el('#call').hidden).toBe(true);
  });

  it('判定を押すと一言が残り件数に変わる', async () => {
    await init();
    clickVerdict('妥当');
    await vi.waitFor(() => {
      expect(el('#call').textContent).toBe('この一覧はすべて評価済みです。');
    });
  });

  it('一言は候補一覧より前にある', () => {
    const call = indexHtml.indexOf('id="call"');
    const list = indexHtml.indexOf('id="candidates"');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(list);
  });
});

/**
 * change はマウスなら「離したとき 1 回」だが、**キーボードの矢印キーは
 * リピートのたびに発火する**。押しっぱなしで毎秒数十回。
 * 1 回ごとに storage 全体の読み込みと検出が走り、さらに sync への保存も走る
 * （sync は 1800 writes/hour）。マウスで踏んだのと同じ問題がキーボードで再発する。
 */
describe('スライダーの連続操作', () => {
  it('change が連続しても保存と再検出は 1 回にまとまる', async () => {
    // Arrange
    await init();
    const slider = el<HTMLInputElement>('#min-cluster');
    applyMock.mockClear();
    // Act — 矢印キーを押しっぱなしにした状況
    for (const value of ['6', '7', '8', '9', '10']) {
      slider.value = value;
      slider.dispatchEvent(new Event('change'));
    }
    // Assert
    await vi.waitFor(() => {
      expect(applyMock).toHaveBeenCalled();
    });
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(
      expect.objectContaining({ minClusterSize: 10 }),
      expect.any(Date),
    );
  });
});

/**
 * デバウンスは「保留中のタイマー」しか束ねない。タイマーが発火した瞬間に
 * applyTimer は null に戻るため、**実行中の適用は次の適用を止めない**。
 * applySettings は storage 全体を 2 回読んで 300 アカウント分の検出を回すので、
 * 重なると二重に走り、後から解決した側が古い設定で上書きしうる。
 * 兄弟の handleVerdict は同じ危険を busy フラグで防いでいる。
 */
describe('適用の直列化', () => {
  it('実行中に次の適用が来ても重ならず、最後の設定が残る', async () => {
    // Arrange — 1 回目の適用を止めておく
    await init();
    const slider = el<HTMLInputElement>('#min-cluster');
    applyMock.mockClear();
    let releaseFirst = (): void => undefined;
    applyMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => {
            resolve(toViews([candidate()], {}));
          };
        }),
    );

    // Act — 1 回目を走らせる
    slider.value = '8';
    slider.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(applyMock).toHaveBeenCalledTimes(1);
    });

    // 1 回目が終わる前に 2 回目（デバウンスも経過させる）
    slider.value = '12';
    slider.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Assert — 直列化されていれば 2 回目はまだ始まっていない
    expect(applyMock).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.waitFor(() => {
      expect(applyMock).toHaveBeenCalledTimes(2);
    });
    // 2 回目は最新の値で走る（古い設定が最後に保存されない）
    expect(applyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ minClusterSize: 12 }),
      expect.any(Date),
    );
  });
});

describe('スライダーの値の丸め', () => {
  it('可動域を超えた値は max に丸めてから保存する', async () => {
    // Arrange — DOM を直接いじられた場合や、HTML の max と RANGES がずれた場合
    await init();
    const slider = el<HTMLInputElement>('#min-cluster');
    slider.max = '999';
    slider.value = '999';
    // Act
    slider.dispatchEvent(new Event('change'));
    // Assert — RANGES.minClusterSize.max は 30
    await vi.waitFor(() => {
      expect(applyMock).toHaveBeenCalledWith(
        expect.objectContaining({ minClusterSize: 30 }),
        expect.any(Date),
      );
    });
  });

  it('可動域を下回る値は min に丸める', async () => {
    await init();
    const slider = el<HTMLInputElement>('#lookback');
    slider.min = '0';
    slider.value = '1';
    slider.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(applyMock).toHaveBeenCalledWith(
        expect.objectContaining({ lookbackDays: 1 }),
        expect.any(Date),
      );
    });
  });
});

/**
 * ポップアップは他所にフォーカスが移った時点で閉じる。根拠リンクを普通に開くと
 * 判定ボタンを押す前に閉じてしまい、記事 1 本ごとに開き直すことになる。
 */
describe('根拠リンク', () => {
  it('背景タブに開き、ポップアップを閉じさせない', async () => {
    // Arrange
    await init();
    const link = document.querySelector<HTMLAnchorElement>('#candidates a');
    if (!link) throw new Error('missing evidence link');
    // Act
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    // Assert — active: false ならフォーカスが移らずポップアップは開いたまま
    expect(vi.mocked(chrome.tabs.create)).toHaveBeenCalledWith({
      url: 'https://qiita.com/example-author-a/items/0123456789abcdef0001',
      active: false,
    });
    // 既定の遷移は止める（止めないと二重に開く）
    expect(event.defaultPrevented).toBe(true);
  });

  it('リンク以外のクリックはタブを開かない', async () => {
    await init();
    clickVerdict('妥当');
    expect(vi.mocked(chrome.tabs.create)).not.toHaveBeenCalled();
  });
});

/**
 * 候補ゼロには原因が 2 つある。1 つの文言にすると、スライダーを上げて
 * ゼロにした人に「トレンドページを開いてください」と的外れな案内を出す。
 */
describe('候補ゼロの案内', () => {
  function emptyState(hasIndex: boolean) {
    return {
      views: [],
      precision: NO_PRECISION,
      settings: SETTINGS,
      rateLimitNotice: null,
      lastScanAt: null,
      hasToken: false,
      hasIndex,
      // 蓄積が無いなら著者も 0 人。**hasIndex と食い違わせない**
      authorCoverage: hasIndex ? COVERAGE : { total: 0, solo: 0 },
      muteOnValid: false,
      foldTarget: 'none' as const,
    };
  }

  it('蓄積が無ければトレンドページを開くよう案内する', async () => {
    loadMock.mockResolvedValue(emptyState(false));
    await init();
    expect(el('#empty').textContent).toContain('トレンドページを開く');
  });

  it('蓄積があるのにゼロなら条件をゆるめるよう案内する', async () => {
    loadMock.mockResolvedValue(emptyState(true));
    await init();
    expect(el('#empty').textContent).toContain('条件をゆるめる');
    expect(el('#empty').textContent).not.toContain('トレンドページを開く');
  });

  it('スライダーでゼロになったときも条件の案内に変わる', async () => {
    // Arrange — 蓄積はある状態で始める
    await init();
    applyMock.mockResolvedValue([]);
    // Act — 閾値を上げて候補が消えた
    const slider = el<HTMLInputElement>('#min-cluster');
    slider.value = '30';
    slider.dispatchEvent(new Event('change'));
    // Assert
    await vi.waitFor(() => {
      expect(el('#empty').hidden).toBe(false);
    });
    expect(el('#empty').textContent).toContain('条件をゆるめる');
  });
});

/**
 * バッジはスキャン時だけでなく、閾値を変えたときも合わせる。
 * 合わせないと一覧が 5 件を出しているのにバッジは前回の 2 件を出し続ける。
 */
describe('バッジの追従', () => {
  it('閾値を変えたら件数をバッジに反映する', async () => {
    // Arrange
    await init();
    vi.mocked(chrome.action.setBadgeText).mockClear();
    applyMock.mockResolvedValue([]);
    // Act
    const slider = el<HTMLInputElement>('#min-cluster');
    slider.value = '30';
    slider.dispatchEvent(new Event('change'));
    // Assert — 候補が消えたのでバッジも空になる
    await vi.waitFor(() => {
      expect(vi.mocked(chrome.action.setBadgeText)).toHaveBeenCalledWith({ text: '' });
    });
  });
});

/**
 * 候補が増えて中身が 600px を超えるとスクロールバーが出る。そのぶん幅が
 * 変わり、ポップアップ全体が左右にズレる。**出るときだけ場所を作るのではなく、
 * 最初から空けておく。**jsdom はスクロールバーを再現しないので、
 * 宣言が消えていないことを実ファイルに対して固定する。
 */
describe('スクロールバーによるレイアウトのズレ', () => {
  it('中身の高さを常に 600px 超にして、窓幅が変わらないようにする', () => {
    // 実測: 中身が 600px をまたぐと innerWidth が 552 ⇄ 567 で変わり、
    // 右端固定のポップアップは全体が左へ 15px ずれる。またがせなければ起きない。
    // html の overflow-y / scrollbar-gutter では直らないことを実測で確認済み
    const body = indexHtml.slice(indexHtml.indexOf('body {'), indexHtml.indexOf('[hidden]'));
    const line = body.split('\n').find((row) => row.includes('min-height:'));
    expect(line).toBeDefined();
    const value = Number.parseInt(line?.split(':')[1] ?? '', 10);
    // padding 32px と合わせて 600 を超えること（いまは 569 + 32 = 601）
    expect(value + 32).toBeGreaterThan(600);
  });
});

/**
 * ポップアップは開いたまま数分生きる。その間に別タブでトレンドページを開けば
 * スキャンが走り、429 に達すれば service worker がバッジを「!」にする。
 *
 * init のスナップショットだけを握っていると、**スライダーを 1 つ動かした瞬間に
 * 候補件数でバッジを上書きし、「!」を消してしまう。**
 */
describe('開いている間に 429 に達したとき', () => {
  const badgeMock = () => vi.mocked(chrome.action.setBadgeText);

  /**
   * 登録された storage のリスナーを取り出す。
   *
   * unbound-method は @types/chrome が addListener をメソッドとして宣言して
   * いるために出る。vi.mocked は受け取った値をそのまま返すだけで、
   * this を切り離した呼び出しはしていない
   */
  function storageListener() {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0]?.[0];
    if (!listener) throw new Error('missing storage listener');
    return listener;
  }

  /** service worker が rateLimitedUntil を書いた（消した）と見立てて通知する */
  function notifyRateLimit(newValue: number | undefined): void {
    storageListener()({ rateLimitedUntil: { newValue } }, 'local');
  }

  /** いまから n 分後の Unix 秒。storage が持つのはミリ秒ではない */
  function minutesFromNow(minutes: number): number {
    return Math.floor(Date.now() / 1000) + minutes * 60;
  }

  it('案内とバッジがその場で追従する（開き直さなくても分かる）', async () => {
    // Arrange — 開いた時点では枠に余裕がある
    await init();
    badgeMock().mockClear();
    // Act
    notifyRateLimit(minutesFromNow(42));
    // Assert
    expect(el('#notice').hidden).toBe(false);
    expect(el('#notice').textContent).toContain('42 分');
    expect(badgeMock()).toHaveBeenCalledWith({ text: '!' });
  });

  it('そのあとスライダーを動かしても「!」を消さない', async () => {
    // Arrange
    await init();
    notifyRateLimit(minutesFromNow(42));
    badgeMock().mockClear();
    // Act — 閾値を変えて再描画させる
    const slider = el<HTMLInputElement>('#min-cluster');
    slider.value = '3';
    slider.dispatchEvent(new Event('change'));
    // Assert — 候補件数で上書きしない
    await vi.waitFor(() => {
      expect(badgeMock()).toHaveBeenCalled();
    });
    expect(badgeMock()).toHaveBeenLastCalledWith({ text: '!' });
  });

  it('枠が戻ったら案内を消す', async () => {
    // Arrange
    await init();
    notifyRateLimit(minutesFromNow(42));
    // Act — スキャンが 429 なしで終わるとキーごと消える
    notifyRateLimit(undefined);
    // Assert
    expect(el('#notice').hidden).toBe(true);
    expect(badgeMock()).toHaveBeenLastCalledWith({ text: '1' });
  });

  it('関係のないキーの変更では何もしない', async () => {
    // Arrange
    await init();
    badgeMock().mockClear();
    // Act — 候補の保存など、スキャンのたびに起きる書き込み
    storageListener()({ candidates: { newValue: [] } }, 'local');
    // Assert
    expect(badgeMock()).not.toHaveBeenCalled();
    expect(el('#notice').hidden).toBe(true);
  });
});

/**
 * 著者をまたぐ共起（Phase 5b-2）。根拠記事は自分のぶんしか持たないので、
 * 他の著者が居ることは文言で示す。
 */
describe('coAuthors の行', () => {
  function withCoAuthors(coAuthors: string[] | undefined) {
    const base = candidate();
    const target = coAuthors === undefined ? base : { ...base, coAuthors };
    return {
      views: toViews([target], {}),
      precision: NO_PRECISION,
      settings: SETTINGS,
      rateLimitNotice: null,
      lastScanAt: null,
      hasToken: false,
      hasIndex: true,
      authorCoverage: COVERAGE,
      muteOnValid: false,
      foldTarget: 'none' as const,
    };
  }

  it('他の著者が居れば行を出す', async () => {
    // Arrange
    loadMock.mockResolvedValue(withCoAuthors(['example-author-z']));
    // Act
    await init();
    // Assert
    const line = document.querySelector('#candidates .co-authors');
    expect(line?.textContent).toContain('example-author-z');
  });

  it('他の著者が居なければ行ごと出さない', async () => {
    // Arrange — 著者内クラスタだけで成立した候補
    loadMock.mockResolvedValue(withCoAuthors(undefined));
    // Act
    await init();
    // Assert — 空の <p> を置くと余白だけが残る
    expect(document.querySelector('#candidates .co-authors')).toBeNull();
  });

  it('空配列でも行を出さない', async () => {
    loadMock.mockResolvedValue(withCoAuthors([]));
    await init();
    expect(document.querySelector('#candidates .co-authors')).toBeNull();
  });

  it('ハンドルを HTML として解釈しない', async () => {
    // Arrange — 著者ハンドルは Qiita 由来の外部データ
    loadMock.mockResolvedValue(withCoAuthors(['<img src=x onerror=alert(1)>']));
    // Act
    await init();
    // Assert
    const line = document.querySelector('#candidates .co-authors');
    expect(line?.querySelector('img')).toBeNull();
    expect(line?.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

/**
 * 「妥当」と同時のミュート。**既定はオフ。**
 *
 * 起動は storage.onChanged ではなくメッセージで行う。評価が既に valid なら
 * storage の値が変わらず通知が発火せず、**押し直しでのやり直しができなくなる**。
 * ミュートは状態の同期ではなく操作である。
 */
describe('「妥当」と同時のミュート', () => {
  const TREND_TAB = 1;

  function stateWithMute(muteOnValid: boolean, views = toViews([candidate()], {})) {
    return {
      views,
      precision: NO_PRECISION,
      settings: SETTINGS,
      rateLimitNotice: null,
      lastScanAt: null,
      hasToken: false,
      hasIndex: true,
      authorCoverage: COVERAGE,
      muteOnValid,
      foldTarget: 'none' as const,
    };
  }

  function tabsQueryMock() {
    // @types/chrome の query はオーバーロードを複数持ち、vi.mocked が
    // void を返すシグネチャを拾う。実行時には配列が返るので、ここだけ型を黙らせる
    return vi.mocked(chrome.tabs.query) as unknown as {
      mockResolvedValue: (value: chrome.tabs.Tab[]) => void;
    };
  }

  function sendMessageMock() {
    return vi.mocked(chrome.tabs.sendMessage) as unknown as {
      mockResolvedValue: (value: unknown) => void;
      mockRejectedValue: (value: unknown) => void;
      mock: { calls: unknown[][] };
    };
  }

  function muteResult(handle: string, outcome: string) {
    return { type: 'MUTE_RESULT', handle, outcome };
  }

  beforeEach(() => {
    tabsQueryMock().mockResolvedValue([tab(TREND_TAB, 'https://qiita.com/trend', true)]);
    sendMessageMock().mockResolvedValue(muteResult('example-author-a', 'muted'));
  });

  it('チェックがオンなら「妥当」でミュートを依頼する', async () => {
    // Arrange
    loadMock.mockResolvedValue(stateWithMute(true));
    await init();
    // Act
    clickVerdict('妥当');
    // Assert
    await vi.waitFor(() => {
      expect(sendMessageMock().mock.calls).toHaveLength(1);
    });
    expect(sendMessageMock().mock.calls[0]).toEqual([
      TREND_TAB,
      { type: 'MUTE_AUTHOR', handle: 'example-author-a' },
    ]);
  });

  /**
   * ★ **この設計の番人。**
   * storage.onChanged で起動する実装に変えると、2 回目は値が変わらないため
   * 通知が発火せず、ここが落ちる。押し直しがそのままリトライ手段になっている。
   */
  it('同じ著者に「妥当」を 2 回押すと、2 回ミュートを依頼する', async () => {
    // Arrange
    loadMock.mockResolvedValue(stateWithMute(true));
    await init();
    // Act — 1 回目
    clickVerdict('妥当');
    await vi.waitFor(() => {
      expect(sendMessageMock().mock.calls).toHaveLength(1);
    });
    // Act — 2 回目（評価は既に valid なので storage の値は変わらない）
    clickVerdict('妥当');
    // Assert
    await vi.waitFor(() => {
      expect(sendMessageMock().mock.calls).toHaveLength(2);
    });
  });

  it('チェックがオフなら依頼しない', async () => {
    // Arrange — 既定の状態
    loadMock.mockResolvedValue(stateWithMute(false));
    await init();
    // Act
    clickVerdict('妥当');
    // handleVerdict が最後まで走るのを待つ。**verdictMock の呼び出しでは足りない** —
    // 即座に解決するので、requestMute の await 連鎖が始まる前にアサートしてしまう。
    // 再描画は handleVerdict の末尾なので、ここまで来れば全部終わっている
    await vi.waitFor(() => {
      expect(document.querySelector('#candidates button[aria-pressed="true"]')).not.toBeNull();
    });
    // Assert — 評価は記録されるが Qiita 側は変えない
    expect(sendMessageMock().mock.calls).toHaveLength(0);
  });

  it('「誤り」では依頼しない', async () => {
    // Arrange
    loadMock.mockResolvedValue(stateWithMute(true));
    await init();
    // Act
    clickVerdict('誤り');
    // handleVerdict が最後まで走るのを待つ。**verdictMock の呼び出しでは足りない** —
    // 即座に解決するので、requestMute の await 連鎖が始まる前にアサートしてしまう。
    // 再描画は handleVerdict の末尾なので、ここまで来れば全部終わっている
    await vi.waitFor(() => {
      expect(document.querySelector('#candidates button[aria-pressed="true"]')).not.toBeNull();
    });
    // Assert — 誤検知だったものをミュートしては本末転倒
    expect(sendMessageMock().mock.calls).toHaveLength(0);
  });

  it('トレンドタブが無ければ依頼せず、案内を出す', async () => {
    // Arrange
    tabsQueryMock().mockResolvedValue([]);
    loadMock.mockResolvedValue(stateWithMute(true));
    await init();
    // Act
    clickVerdict('妥当');
    // Assert
    await vi.waitFor(() => {
      expect(el('#candidates').textContent).toContain('トレンドページを開いてから');
    });
    expect(sendMessageMock().mock.calls).toHaveLength(0);
  });

  it('トレンドページのタブにだけ送る', async () => {
    // Arrange — 記事ページのタブが先に並んでいても、そちらへは送らない
    tabsQueryMock().mockResolvedValue([
      tab(9, 'https://qiita.com/example-author-a/items/0123456789abcdef0001', true),
      tab(TREND_TAB, 'https://qiita.com/trend'),
    ]);
    loadMock.mockResolvedValue(stateWithMute(true));
    await init();
    // Act
    clickVerdict('妥当');
    // Assert
    await vi.waitFor(() => {
      expect(sendMessageMock().mock.calls).toHaveLength(1);
    });
    expect(sendMessageMock().mock.calls[0]?.[0]).toBe(TREND_TAB);
  });

  it('届かなくても落ちず、押し直しを促す', async () => {
    // Arrange — 拡張をリロードすると content script が孤児になる
    sendMessageMock().mockRejectedValue(new Error('Receiving end does not exist'));
    loadMock.mockResolvedValue(stateWithMute(true));
    await init();
    // Act
    clickVerdict('妥当');
    // Assert
    await vi.waitFor(() => {
      expect(el('#candidates').textContent).toContain('再読み込み');
    });
  });

  it('結果の文言を候補の行に出す', async () => {
    // Arrange
    loadMock.mockResolvedValue(stateWithMute(true));
    await init();
    // Act
    clickVerdict('妥当');
    // Assert
    await vi.waitFor(() => {
      expect(el('#candidates .mute-status').textContent).toBe('Qiita 側でミュートしました。');
    });
  });

  it('まだ試していない候補には結果の行を出さない', async () => {
    loadMock.mockResolvedValue(stateWithMute(true));
    await init();
    expect(document.querySelector('#candidates .mute-status')).toBeNull();
  });

  it('解除の案内リンクは背景タブで開く', async () => {
    // Arrange — 同じタブで開くとポップアップが閉じ、評価の続きができなくなる
    loadMock.mockResolvedValue(stateWithMute(false));
    await init();
    // Act
    el('#mute-note a').click();
    // Assert
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://qiita.com/settings/mutes',
      active: false,
    });
  });
});

/**
 * ★ orch-review（2026-08-24）が見つけた欠陥の番人。
 *
 * recordMuteOutcome は「成功したという事実は取り消されない」と書いてあるのに、
 * 評価を押し直しただけで「ミュート済み」の表示が消えていた。
 * ミュート済みの候補は、再検出されるまで一覧に残り続ける（ミュートしても
 * candidates は消えない）ので、これは普通に踏む経路。
 */
describe('既にミュート済みの候補の表示', () => {
  /**
   * **他のテストが触らないハンドルを使う。**
   *
   * popup-page.ts はこのファイルで 1 度だけ import されるので、モジュール変数は
   * テスト間で残る。`example-author-a` を使うと、先行するテストが requestMute で
   * 埋めた値を拾ってしまい、**バグがあっても通る**（最初にそう書いて素通りした）。
   */
  const HANDLE = 'example-author-muted';
  const MUTED = {
    [HANDLE]: {
      outcome: 'muted' as const,
      at: '2026-08-24T12:00:00.000Z',
      mutedAt: '2026-08-24T12:00:00.000Z',
    },
  };

  function stateWithMuted(muteOnValid: boolean) {
    return {
      views: toViews([candidate(HANDLE)], {}, MUTED),
      precision: NO_PRECISION,
      settings: SETTINGS,
      rateLimitNotice: null,
      lastScanAt: null,
      hasToken: false,
      hasIndex: true,
      authorCoverage: COVERAGE,
      muteOnValid,
      foldTarget: 'none' as const,
    };
  }

  /** 評価が描き直されるまで待つ（handleVerdict の末尾） */
  async function waitForRerender(): Promise<void> {
    await vi.waitFor(() => {
      expect(document.querySelector('#candidates button[aria-pressed="true"]')).not.toBeNull();
    });
  }

  it('開いた直後は結果が出ている', async () => {
    loadMock.mockResolvedValue(stateWithMuted(false));
    await init();
    expect(el('#candidates .mute-status').textContent).toContain('ミュートしました');
  });

  it('「誤り」を押しても結果表示は消えない', async () => {
    // Arrange — 前のセッションでミュート済み
    loadMock.mockResolvedValue(stateWithMuted(false));
    await init();
    // Act — 評価を訂正しただけ。ミュートの成否とは無関係
    clickVerdict('誤り');
    await waitForRerender();
    // Assert
    expect(document.querySelector('#candidates .mute-status')).not.toBeNull();
  });

  it('チェックがオフのまま「妥当」を押しても結果表示は消えない', async () => {
    // Arrange
    loadMock.mockResolvedValue(stateWithMuted(false));
    await init();
    // Act — ミュートは依頼していないので、結果を上書きする理由が無い
    clickVerdict('妥当');
    await waitForRerender();
    // Assert
    expect(document.querySelector('#candidates .mute-status')).not.toBeNull();
  });
});
/**
 * 投稿直後の幅（Phase 9）。**既定は 60 分で現状維持。**
 *
 * 追加の 1 本も既存 3 本と同じ input / change の二段構えに載せる。
 * ここに非同期を 1 つでも足すと、Phase 6 で潰した「つまみが指の下から
 * 逃げる」が戻る。
 *
 * **下限（絞り込み）は作らない。**いつ押すかを握っているのは攻撃側なので、
 * 下限を設ければ時刻をずらすだけで候補から消える。
 */
describe('投稿直後のスライダー', () => {
  it('幅の change で 4 項目すべてを保存する', async () => {
    // Arrange
    await init();
    const slider = el<HTMLInputElement>('#burst-window');
    // Act — 値は分ではなく目盛りの添字。3 は 360 分
    slider.value = '3';
    slider.dispatchEvent(new Event('change'));
    // Assert
    await vi.waitFor(() => {
      expect(applyMock).toHaveBeenCalledWith(
        {
          minClusterSize: 5,
          minSharedItems: 2,
          lookbackDays: 3,
          burstWindowMinutes: 360,
        },
        expect.any(Date),
      );
    });
  });

  it('ドラッグ中（input）は再検出も保存もしない', async () => {
    // Arrange
    await init();
    const slider = el<HTMLInputElement>('#burst-window');
    applyMock.mockClear();
    // Act
    for (const value of ['1', '2', '3', '4', '5']) {
      slider.value = value;
      slider.dispatchEvent(new Event('input'));
    }
    // Assert — 数字の表示だけが即座に追従する。添字 5 は 1 日
    expect(applyMock).not.toHaveBeenCalled();
    expect(el('#burst-window-value').textContent).toBe('1 日');
  });

  it('幅の表示に単位を付ける', async () => {
    await init();
    expect(el('#burst-window-value').textContent).toBe('180 分');
  });

  it('つまみは分ではなく目盛りの添字を指す', async () => {
    // Arrange — 既定は 180 分 = 添字 2。分（180）を入れると max=6 に丸められ、
    // **つまみだけが右端に飛ぶ**。ラベルは settings から作るので気づけない
    await init();
    // Act & Assert
    expect(el<HTMLInputElement>('#burst-window').value).toBe('2');
    expect(el<HTMLInputElement>('#burst-window').max).toBe('6');
  });

  it('添字 0 に戻せる（左端が有効な値）', async () => {
    // Arrange — 添字 0 は 60 分。共通の read() は parsed <= 0 を弾くので、
    // そこに通すと左端に行かない（minBurstScore で踏みかけた罠）
    await init();
    const slider = el<HTMLInputElement>('#burst-window');
    // Act
    slider.value = '0';
    slider.dispatchEvent(new Event('change'));
    // Assert
    await vi.waitFor(() => {
      expect(applyMock).toHaveBeenCalledWith(
        expect.objectContaining({ burstWindowMinutes: 60 }),
        expect.any(Date),
      );
    });
  });

  it('右端は 2 日', async () => {
    await init();
    const slider = el<HTMLInputElement>('#burst-window');
    slider.value = '6';
    slider.dispatchEvent(new Event('input'));
    expect(el('#burst-window-value').textContent).toBe('2 日');
  });

  it('候補の占有率の行に幅と実件数を出す', async () => {
    // Arrange & Act
    await init();
    // Assert — フィクスチャは窓内 5 件中 4 件
    const text = el('#candidates .share').textContent;
    expect(text).toContain('180 分以内');
    expect(text).toContain('4/5 アカウント (80%)');
  });

  it('見出しに「共通」と書かない（clusterSize は和集合）', async () => {
    // **総いいね 26 件の記事に「30 アカウントが共通」と出ていた**（2026-08-25 実機）。
    // 26 人しかいない記事に 30 人は入らない。clusterSize は連結成分の和集合で、
    // 全記事に共通する集合ではない
    await init();
    const text = el('#candidates .stats').textContent;
    expect(text).not.toContain('共通');
    expect(text).toContain('2 記事に重なった 9 アカウント');
  });

  it('空アカウント率の行を出さない', async () => {
    // **比較相手を決めない割合は強さを誤って伝える**（実測 2026-08-25:
    // 検出された 31 人の空率 61% に対し、同じ記事群の liker 全体が 54%）
    await init();
    const item = el('#candidates li');
    expect(item.textContent).not.toContain('記事 0 本');
    expect(item.querySelector('.scores')).toBeNull();
  });

  it('幅は見出しに書かない（候補の件数を変えないので条件ではない）', async () => {
    // Arrange & Act
    await init();
    const slider = el<HTMLInputElement>('#burst-window');
    slider.value = '180';
    slider.dispatchEvent(new Event('input'));
    // Assert — 「判定の条件」に並べると絞り込みに効くと読める
    expect(el('#conditions-summary').textContent).not.toContain('分以内');
  });
});

/**
 * 折りたたみ（Phase 9）。**表示だけの設定で、判定には関与しない。**
 *
 * 中で「誤り」が押せることが、誤検知でミュートしたアカウントを回収する
 * 唯一の経路になる（OQ-16 と同じ形）。
 */
describe('評価済みの折りたたみ', () => {
  const AT = '2026-08-25T12:00:00.000Z';

  /** 未評価 a / 妥当・ミュート成功 b の 2 件 */
  function twoViews(): PopupState.CandidateView[] {
    return toViews(
      [candidate('example-author-a'), candidate('example-author-b')],
      { 'example-author-b': 'valid' },
      { 'example-author-b': { outcome: 'muted' as const, at: AT, mutedAt: AT } },
    );
  }

  function stateWithFold(foldTarget: PopupState.PopupState['foldTarget']) {
    return {
      views: twoViews(),
      precision: { valid: 1, falsePositive: 0, ratio: 1 },
      settings: SETTINGS,
      rateLimitNotice: null,
      lastScanAt: null,
      hasToken: false,
      hasIndex: true,
      authorCoverage: COVERAGE,
      muteOnValid: false,
      foldTarget,
    };
  }

  /** 折りたたみの中のボタンを押す */
  function clickFoldedVerdict(label: string): void {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#folded-candidates button')];
    const target = buttons.find((button) => button.textContent === label);
    if (!target) throw new Error(`missing folded button: ${label}`);
    target.click();
  }

  it('既定（none）では 1 件も折りたたまない', async () => {
    // Arrange
    loadMock.mockResolvedValue(stateWithFold('none'));
    // Act
    await init();
    // Assert
    expect(document.querySelectorAll('#candidates li')).toHaveLength(2);
    expect(document.querySelectorAll('#folded-candidates li')).toHaveLength(0);
    expect(el('#folded').hidden).toBe(true);
  });

  it('保存済みの設定で評価済みを折りたたむ', async () => {
    // Arrange — 選ぶ操作は設定ページ。ポップアップは開いたときの値に従うだけ
    loadMock.mockResolvedValue(stateWithFold('judged'));
    // Act
    await init();
    // Assert
    expect(document.querySelectorAll('#candidates li')).toHaveLength(1);
    expect(document.querySelectorAll('#folded-candidates li')).toHaveLength(1);
    expect(el('#folded').hidden).toBe(false);
    expect(el('#folded-summary').textContent).toContain('1 件');
  });

  it('折りたたみの表示だけでは再検出しない（storage 全体を読み直さない）', async () => {
    // Arrange — 表示だけの設定。applySettings は storage を 2 回読んで検出を回す
    loadMock.mockResolvedValue(stateWithFold('judged'));
    // Act
    await init();
    // **デバウンス（250ms）を越えて待つ。**同期で見るだけだと、あとから
    // scheduleApply を足しても落ちない（変異テストで判明）
    await new Promise((resolve) => setTimeout(resolve, APPLY_DEBOUNCE_MS + 150));
    // Assert
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('折りたたみの中の候補にも「ミュートしています…」を出せる', async () => {
    // Arrange — 依頼から応答まで数秒かかる。どの行で起きているか分からないと
    // ユーザーは押せたのかどうか判断できない。
    // **応答を保留する**ことで、途中の表示だけを観測する
    (
      vi.mocked(chrome.tabs.query) as unknown as {
        mockResolvedValue: (value: chrome.tabs.Tab[]) => void;
      }
    ).mockResolvedValue([tab(1, 'https://qiita.com/trend', true)]);
    let settle: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      settle = resolve;
    });
    (
      vi.mocked(chrome.tabs.sendMessage) as unknown as {
        mockReturnValue: (value: unknown) => void;
      }
    ).mockReturnValue(pending);
    loadMock.mockResolvedValue({ ...stateWithFold('judged'), muteOnValid: true });
    await init();
    // Act — 折りたたみの中の「妥当」を押し直す
    clickFoldedVerdict('妥当');
    // Assert — 行を #candidates の中だけで探すと、ここには出ない
    await vi.waitFor(() => {
      expect(el('#folded-candidates .mute-status').textContent).toContain('ミュートしています');
    });
    settle({ type: 'MUTE_RESULT', handle: 'example-author-b', outcome: 'muted' });
    await pending;
  });

  it('折りたたみの中でも「誤り」が押せる（誤検知の回収経路）', async () => {
    // Arrange
    loadMock.mockResolvedValue(stateWithFold('valid'));
    await init();
    expect(document.querySelectorAll('#folded-candidates li')).toHaveLength(1);
    // Act
    clickFoldedVerdict('誤り');
    // Assert — 評価が記録され、一覧に戻る
    await vi.waitFor(() => {
      expect(verdictMock).toHaveBeenCalledWith('example-author-b', 'false_positive');
    });
    await vi.waitFor(() => {
      expect(document.querySelectorAll('#candidates li')).toHaveLength(2);
    });
  });

  it('ミュート済みだけを折りたたむ場合、「誤り」でも中に残る', async () => {
    // Arrange — Qiita 側のミュートは解除されないので、残るのが事実
    loadMock.mockResolvedValue(stateWithFold('muted'));
    await init();
    // Act
    clickFoldedVerdict('誤り');
    await vi.waitFor(() => {
      expect(verdictMock).toHaveBeenCalled();
    });
    // Assert
    await vi.waitFor(() => {
      expect(document.querySelectorAll('#folded-candidates li')).toHaveLength(1);
    });
  });

  it('ミュート済みが居れば解除の案内を出す', async () => {
    loadMock.mockResolvedValue(stateWithFold('muted'));
    await init();
    expect(el('#fold-note').hidden).toBe(false);
  });

  it('ミュート済みが居なければ案内を出さない', async () => {
    // Arrange — 評価だけして一度もミュートしていない
    loadMock.mockResolvedValue({
      ...stateWithFold('judged'),
      views: toViews([candidate('example-author-b')], { 'example-author-b': 'valid' }),
    });
    // Act
    await init();
    // Assert
    expect(el('#fold-note').hidden).toBe(true);
  });

  it('解除の案内は背景タブで開く（ポップアップを閉じさせない）', async () => {
    // Arrange
    loadMock.mockResolvedValue(stateWithFold('muted'));
    await init();
    const link = el<HTMLAnchorElement>('#fold-note a');
    // Act
    link.click();
    // Assert
    expect(vi.mocked(chrome.tabs.create)).toHaveBeenCalledWith(
      expect.objectContaining({ active: false }),
    );
  });

  it('折りたたみの中の根拠リンクも背景タブで開く', async () => {
    // Arrange
    loadMock.mockResolvedValue(stateWithFold('valid'));
    await init();
    const link = document.querySelector<HTMLAnchorElement>('#folded-candidates a');
    // Act
    link?.click();
    // Assert
    expect(vi.mocked(chrome.tabs.create)).toHaveBeenCalledWith(
      expect.objectContaining({ active: false }),
    );
  });

  it('全件折りたたまれても「条件をゆるめて」と言わない', async () => {
    // Arrange — 評価済み 1 件だけ
    loadMock.mockResolvedValue({
      ...stateWithFold('judged'),
      views: toViews([candidate('example-author-b')], { 'example-author-b': 'valid' }),
    });
    // Act
    await init();
    // Assert — 何もしていない人に条件をいじらせるのは的外れ
    expect(el('#empty').hidden).toBe(false);
    expect(el('#empty').textContent).toContain('折りたたみ');
    expect(el('#empty').textContent).not.toContain('ゆるめる');
  });

  it('折りたたんでもバッジは候補の総数のまま', async () => {
    // Arrange — バッジを書くのは service worker。表示設定を知る筋合いがない
    loadMock.mockResolvedValue(stateWithFold('judged'));
    // Act — 一覧には 1 件しか出ないが、候補は 2 件ある
    await init();
    // Assert
    expect(document.querySelectorAll('#candidates li')).toHaveLength(1);
    expect(vi.mocked(chrome.action.setBadgeText)).toHaveBeenCalledWith({ text: '2' });
  });
});

/** 実際に配布される index.html に対して固定する（骨格のモックではなく） */
describe('index.html の折りたたみ', () => {
  it('見え方の設定はポップアップに置かない（設定ページへ移した）', () => {
    // ポップアップは候補を読む場所。設定は options ページに集める
    expect(indexHtml).not.toContain('id="fold-target"');
    expect(indexHtml).not.toContain('id="mute-on-valid"');
  });

  it('ミュートの案内は最終スキャンの直後にある', () => {
    const lastScan = indexHtml.indexOf('id="last-scan"');
    const note = indexHtml.indexOf('id="mute-note"');
    const conditions = indexHtml.indexOf('id="conditions"');
    expect(lastScan).toBeLessThan(note);
    expect(note).toBeLessThan(conditions);
  });

  it('折りたたみの器は候補一覧より後ろにある', () => {
    const folded = indexHtml.indexOf('id="folded"');
    const list = indexHtml.indexOf('id="candidates"');
    expect(folded).toBeGreaterThan(list);
  });

  it('既定で閉じている（開いていたら折りたたみの意味が無い）', () => {
    expect(indexHtml).toContain('<details id="folded" hidden>');
    expect(indexHtml).not.toContain('<details id="folded" open');
  });

  it('解除の案内をリンクとして持つ（textContent で組み立てない）', () => {
    const note = indexHtml.slice(
      indexHtml.indexOf('id="fold-note"'),
      indexHtml.indexOf('id="folded-candidates"'),
    );
    expect(note).toContain('解除されません');
    expect(note).toContain('https://qiita.com/settings/mutes');
  });

  it('投稿直後のスライダーが判定の条件の中にある', () => {
    const conditions = indexHtml.slice(
      indexHtml.indexOf('<details id="conditions">'),
      indexHtml.indexOf('</details>'),
    );
    expect(conditions).toContain('id="burst-window"');
  });

  it('幅のスライダーは目盛りの添字を持つ（分は等間隔に並ばない）', () => {
    // 分を value にすると 60→2880 を等間隔の目盛りに載せられない
    expect(indexHtml).toContain('id="burst-window" min="0" max="6" step="1"');
  });

  it('下限（絞り込み）のスライダーを置かない', () => {
    // **いつ押すかを握っているのは攻撃側。**下限を設ければ、手口を知った相手は
    // 時刻をずらすだけで候補から消え、しかも消えたことはユーザーに見えない
    expect(indexHtml).not.toContain('id="min-burst"');
  });

  it('幅が候補を絞らないことを画面で明示する', () => {
    // 絞り込みだと誤解されると、ユーザーは件数が変わるのを待ち続ける
    expect(indexHtml).toContain('候補の件数を変えません');
  });
});

/**
 * 設定への入口と、判定ボタンのラベル（2026-08-25 の実機フィードバック）。
 */
describe('設定への入口', () => {
  it('トークンの導線とは別に設定を開ける', async () => {
    // Arrange — 「トークンを設定する」しか無いと、トークンを使わない人が
    // 表示の設定に辿り着けない
    await init();
    // Act
    el<HTMLButtonElement>('#open-settings').click();
    // Assert
    expect(vi.mocked(chrome.runtime.openOptionsPage)).toHaveBeenCalled();
  });

  it('トークンのボタンからも開ける（両方生きている）', async () => {
    await init();
    el<HTMLButtonElement>('#open-options').click();
    expect(vi.mocked(chrome.runtime.openOptionsPage)).toHaveBeenCalled();
  });

  it('ミュートの案内と同じ段落に入っていても押せる', async () => {
    // Arrange — 1 文にまとめたことで #open-settings が #mute-note の中に入った。
    // #mute-note には「リンクなら背景タブで開く」処理が付いている。
    // closest('a[href]') で判定しているので button では反応しない**はず**
    await init();
    // Act
    el<HTMLButtonElement>('#open-settings').click();
    // Assert — 設定は開き、ミュート一覧のタブは開かない
    expect(vi.mocked(chrome.runtime.openOptionsPage)).toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('index.html: 設定の案内が候補一覧より前にある', () => {
    const note = indexHtml.indexOf('id="open-settings"');
    const list = indexHtml.indexOf('id="candidates"');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(list);
  });

  it('index.html: ミュートの案内と同じ 1 段落に収める', () => {
    // ユーザーの指示は「1 行にしたい」。2 つの <p> に分けると 12px の
    // margin が入って 2 行になる
    const note = indexHtml.slice(
      indexHtml.indexOf('id="mute-note"'),
      indexHtml.indexOf('<details id="conditions">'),
    );
    expect(note).toContain('id="open-settings"');
    expect(note.match(/<p /g)).toBeNull();
    expect(indexHtml).not.toContain('id="settings-note"');
  });

  it('index.html: Qiita の設定と拡張機能の設定を区別している', () => {
    // **同じ文の中に Qiita 側の「ミュート設定」が並んでいる。**
    // どちらも「設定」で終わるので、区別は前より効いていなければならない
    const note = indexHtml.slice(
      indexHtml.indexOf('id="mute-note"'),
      indexHtml.indexOf('<details id="conditions">'),
    );
    expect(note).toContain('ミュート設定');
    expect(note).toContain('拡張機能の設定');
  });
});

describe('判定ボタンのラベル', () => {
  it('ボタンの左に「この検出は」を出す', async () => {
    // Arrange — 「妥当」だけでは何に対する判断か読み取れない
    await init();
    // Act & Assert
    expect(el('#candidates .verdict-prompt').textContent).toBe('この検出は');
  });

  it('ラベルはボタンより前にある', async () => {
    await init();
    const actions = el('#candidates .actions');
    expect(actions.firstElementChild?.className).toBe('verdict-prompt');
  });

  it('ラベルを足してもボタンは押せる（委譲が壊れていない）', async () => {
    await init();
    clickVerdict('妥当');
    await vi.waitFor(() => {
      expect(verdictMock).toHaveBeenCalledWith('example-author-a', 'valid');
    });
  });

  it('断定しない（「不正」「スパム」と書かない）', async () => {
    await init();
    const text = el('#candidates .actions').textContent ?? '';
    expect(text).not.toContain('不正');
    expect(text).not.toContain('スパム');
  });
});
