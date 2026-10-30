import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          testTimeout: 20_000,
          include: ['**/src/**/*.test.ts', 'scripts/*.test.ts'],
          exclude: ['**/node_modules/**', '**/.claude/**', '**/*.e2e.test.ts'],
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
