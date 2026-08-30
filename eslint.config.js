import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      // eslint.config.js 自身は tsconfig の include 外なので明示的に許可する
      parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js'] } },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // logger はログの唯一の出口。ここだけ console を許可する
  { files: ['src/lib/logger.ts'], rules: { 'no-console': 'off' } },
);
