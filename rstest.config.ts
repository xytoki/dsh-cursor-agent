import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';

export default defineConfig({
  extends: withRslibConfig(),
  projects: [
    {
      name: 'host',
      testEnvironment: 'node',
      testTimeout: 15_000,
      maxConcurrency: 1,
      include: ['tests/**/*.test.ts'],
      exclude: ['tests/client/**'],
    },
    {
      name: 'client',
      testEnvironment: 'happy-dom',
      setupFiles: ['./rstest.setup.ts'],
      include: ['tests/client/**/*.test.tsx'],
    },
  ],
});
