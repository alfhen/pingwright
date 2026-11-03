import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['**/src/**/*.test.ts', 'scripts/*.test.ts', 'site/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/.claude/**', 'site/dist/**', 'site/.astro/**', '**/*.e2e.test.ts', '**/*.docs.test.ts'],
        },
      },
      {
        test: {
          name: 'docs',
          include: ['scripts/*.docs.test.ts'],
          globalSetup: ['scripts/docs-global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['**/*.e2e.test.ts'],
          exclude: ['**/node_modules/**', '**/.claude/**'],
          globalSetup: ['e2e/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
