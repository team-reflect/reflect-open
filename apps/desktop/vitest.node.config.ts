import { defineDesktopProject } from './vitest.shared.ts'

export default defineDesktopProject({
  test: {
    name: 'node',
    environment: 'node',
    sequence: { groupOrder: 200 },
    include: ['src/**/*.test.ts'],
  },
})
