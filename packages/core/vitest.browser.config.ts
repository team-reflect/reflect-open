import { playwright } from '@vitest/browser-playwright'
import { defineProject } from 'vitest/config'

const browserName = process.env.REFLECT_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium'

export default defineProject({
  test: {
    name: 'core-browser',
    include: ['src/**/*.test.tsx'],
    sequence: { groupOrder: 100 },
    retry: process.env.CI ? 3 : 0,
    slowTestThreshold: 10_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: !process.env.DEBUG,
      instances: [{ browser: browserName }],
    },
  },
})
