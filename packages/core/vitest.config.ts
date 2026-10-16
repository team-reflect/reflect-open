import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: { label: 'core', color: 'magenta' },
    environment: 'node',
    fsModuleCache: true,
    isolate: false,
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    restoreMocks: true,
    sequence: { groupOrder: 200 },
    retry: process.env.CI ? 3 : 0,
  },
})
