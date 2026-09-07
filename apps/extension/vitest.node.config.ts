import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'extension', include: ['lib/**/*.test.ts', 'entrypoints/**/*.test.ts'] },
})
