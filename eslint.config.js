import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'runs/**', 'coverage/**', 'test-results/**', '.claude/**'] },
  ...tseslint.configs.recommended,
);
