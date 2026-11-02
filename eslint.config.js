import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'runs/**', 'coverage/**', 'test-results/**', '.claude/**', '.vitepress/dist/**', '.vitepress/cache/**', 'brand/site-handoff/**'] },
  ...tseslint.configs.recommended,
);
