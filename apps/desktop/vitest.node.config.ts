import { defineDesktopProject } from './vitest.shared'

export default defineDesktopProject({
  test: {
    name: 'node',
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
})
