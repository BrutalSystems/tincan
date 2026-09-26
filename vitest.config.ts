import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'plugins/**/test/**/*.test.ts'],
    environment: 'node',
    // Runs before every test file. Keeps the suite off the real ~/.tincan and
    // out of the ambient session of whoever ran it — see test/setup.ts.
    setupFiles: ['test/setup.ts'],
    testTimeout: 15000,
  },
});
