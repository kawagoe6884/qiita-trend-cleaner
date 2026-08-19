/**
 * options ページのエントリ。
 * 配線とロジックは options-page.ts にある（テストから呼べるようにするため）。
 */
import { logger } from '../../lib/logger';
import { init } from './options-page';

// type="module" は defer 相当で、HTML のパース後に実行される。
// init() は内部で失敗を処理するが、想定外の例外に備えてここでも受ける
void init().catch((error: unknown) => {
  logger.error('failed to initialize options page:', error);
});

logger.info('options page opened');
