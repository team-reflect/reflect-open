import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: import.meta.dirname,
  test: {
    retry: process.env.CI ? 3 : 0,
    slowTestThreshold: 10_000,
    isolate: false,
    projects: [
      './apps/desktop/vitest.*.config.ts',
      './apps/extension/vitest.config.ts',
      './design-system/vitest.config.ts',
      './packages/*/vitest.config.ts',
    ],
  },
})
