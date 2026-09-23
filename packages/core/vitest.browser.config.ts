import { playwright } from '@vitest/browser-playwright'
import { defineProject } from 'vitest/config'

const browserName = process.env.REFLECT_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium'

export default defineProject({
  test: {
    name: 'core-browser',
    include: ['src/**/*.test.tsx'],
    sequence: { groupOrder: 100 },
    retry: process.env.CI ? 3 : 0,
    browser: {
      enabled: true,
      // Vitest 5 defaults locators.exact to true; keep v4 substring matching.
      locators: { exact: false },
      provider: playwright(),
      headless: !process.env.DEBUG,
      instances: [{ browser: browserName }],
    },
  },
})
