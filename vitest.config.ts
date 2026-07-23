import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    retry: process.env.CI ? 3 : 0,
    slowTestThreshold: 10_000,
    fileParallelism: false,
    projects: [
      './apps/desktop/vitest.*.config.ts',
      './apps/extension',
      './packages/*',
    ],
  },
})
