import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: process.env.GITHUB_ACTIONS ? ['github-actions', 'verbose'] : ['default'],
    retry: process.env.CI ? 3 : 0,
    slowTestThreshold: 10_000,
    maxConcurrency: 1,
    fileParallelism: false,
    projects: ['./packages/*', './app/*'],
  },
})
