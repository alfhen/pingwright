import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['**/src/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['**/*.e2e.test.ts'],
          exclude: ['**/node_modules/**'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
