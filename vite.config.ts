/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.ts';

/**
 * `--mode fixture`（`npm run build:fixture`）はスクショ用のビルド。
 *
 * **出力先を `dist/` と分ける。**同じ `dist/` に出すと、fixture で撮ったあと
 * `npm run build` を忘れてそのまま zip にする事故がありうる。さらに Chrome は
 * 読み込んだフォルダで拡張を区別するので、別フォルダにすれば**本番とは別の拡張
 * （別の storage）**として並べて読み込める — fixture の初期化（storage を消して
 * 書く）が本番の蓄積や評価に届かない。
 */
export default defineConfig(({ mode }) => ({
  plugins: [crx({ manifest })],
  build: { outDir: mode === 'fixture' ? 'dist-fixture' : 'dist', emptyOutDir: true },
  publicDir: 'public',
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    unstubGlobals: true,
  },
}));
