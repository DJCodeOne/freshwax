import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      include: [
        'src/lib/**/*.ts',
        'src/pages/api/**/*.ts',
      ],
      thresholds: {
        lines: 5,
      },
    },
  },
  resolve: {
    alias: {
      '@lib': '/src/lib',
    },
  },
});
