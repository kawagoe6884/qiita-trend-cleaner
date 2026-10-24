/**
 * options ページのテスト用の DOM。options-page.test.ts と options-page-agreement.test.ts で共有する。
 *
 * index.html と同じ骨格（id と hidden の扱いを実物に合わせる）。
 * **順序は実ファイルに対して検査する**（options-page.test.ts の「index.html のレイアウト順序」）。
 */
export function setupDom(): void {
  document.body.innerHTML = `
    <section class="mode">
      <p class="mode-title" id="mode-title"></p>
      <p class="mode-detail" id="mode-detail"></p>
    </section>
    <section id="saved" class="saved" hidden>
      <span class="saved-label">設定済みのトークン</span>
      <code id="masked"></code>
      <button type="button" id="remove">削除する</button>
    </section>
    <form id="token-form">
      <input type="password" id="token" autocomplete="off" />
      <button type="submit" id="save">保存する</button>
    </form>
    <p id="message" role="status" aria-live="polite"></p>
    <section class="prefs">
      <label class="toggle">
        <input type="checkbox" id="mute-on-valid" />
        <span class="track"></span>
        <span>「妥当」と同時に Qiita 側でもミュート</span>
        <strong class="toggle-state" id="mute-on-valid-state"></strong>
      </label>
      <div class="fold-grid">
        <label class="fold-option">
          <input type="radio" name="fold-target" value="none" />そのまま一覧に出す
        </label>
        <label class="fold-option">
          <input type="radio" name="fold-target" value="muted" />ミュート済みだけ
        </label>
        <label class="fold-option">
          <input type="radio" name="fold-target" value="valid" />「妥当」だけ
        </label>
        <label class="fold-option">
          <input type="radio" name="fold-target" value="judged" />評価済みをすべて
        </label>
      </div>
    </section>
    <section class="prefs">
      <div class="ai-grid">
        <input type="range" id="ai-threshold" min="1" max="8" step="1" />
        <output id="ai-threshold-value"></output>
        <div class="ai-control">
          <button type="button" class="preset" data-min-prose="0" aria-pressed="false">0</button>
          <button type="button" class="preset" data-min-prose="200" aria-pressed="false">200</button>
          <button type="button" class="preset" data-min-prose="400" aria-pressed="false">400</button>
          <button type="button" class="preset" data-min-prose="1000" aria-pressed="false">1000</button>
          <input type="number" id="ai-min-prose" min="0" max="2000" step="1" placeholder="自由入力" />
        </div>
      </div>
      <label class="toggle">
        <input type="checkbox" id="ai-dim-likely" />
        <span class="track"></span>
        <span>強調される記事を薄く表示する</span>
        <strong class="toggle-state" id="ai-dim-likely-state"></strong>
      </label>
      <p id="ai-agreement-summary"></p>
      <table><tbody id="ai-agreement-rows"></tbody></table>
      <p id="ai-agreement-legacy" hidden></p>
    </section>`;
}

export function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}
