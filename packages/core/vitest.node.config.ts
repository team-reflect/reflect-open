import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'core-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    sequence: { groupOrder: 200 },
    retry: process.env.CI ? 3 : 0,
    slowTestThreshold: 10_000,
  },
})
