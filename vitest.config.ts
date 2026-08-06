import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: import.meta.dirname,
  test: {
    retry: process.env.CI ? 3 : 0,
    slowTestThreshold: 10_000,
    fileParallelism: false,
    projects: [
      './apps/desktop/vitest.*.config.ts',
      './apps/extension',
      './packages/core/vitest.*.config.ts',
      './packages/db',
      './packages/utils',
    ],
  },
})
