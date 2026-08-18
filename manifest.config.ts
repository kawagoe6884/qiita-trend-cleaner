import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Qiita Trend Guard',
  version: pkg.version,
  description: 'Qiita のトレンドから、不自然ないいねパターンが検出された記事を隠します。',
  icons: {
    16: 'icons/icon-16.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  permissions: ['storage', 'alarms'],
  host_permissions: ['https://qiita.com/*'],
  background: { service_worker: 'src/background/service-worker.ts', type: 'module' },
  content_scripts: [
    {
      matches: ['https://qiita.com/*'],
      js: ['src/content/content-script.ts'],
      run_at: 'document_idle',
    },
  ],
  action: { default_popup: 'src/ui/popup/index.html' },
  options_page: 'src/ui/options/index.html',
});
