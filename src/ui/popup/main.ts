/**
 * ポップアップのエントリ。
 * 配線とロジックは popup-page.ts にある（テストから呼べるようにするため）。
 */
import { logger } from '../../lib/logger';
import { init } from './popup-page';

// type="module" は defer 相当で、HTML のパース後に実行される。
// init() は内部で失敗を処理するが、想定外の例外に備えてここでも受ける
void init().catch((error: unknown) => {
  logger.error('failed to initialize popup:', error);
});

logger.info('popup opened');
