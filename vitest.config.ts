import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          testTimeout: 20_000,
          include: ['**/src/**/*.test.ts', 'scripts/*.test.ts'],
          exclude: ['**/node_modules/**', '**/.claude/**', '**/*.e2e.test.ts', '**/*.docs.test.ts'],
        },
      },
      {
        test: {
          name: 'docs',
          include: ['scripts/*.docs.test.ts'],
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
