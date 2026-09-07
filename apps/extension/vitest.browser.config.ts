import { playwright } from '@vitest/browser-playwright'
import { defineProject } from 'vitest/config'

const browserName = process.env.REFLECT_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium'

export default defineProject({
  test: {
    name: 'extension-browser',
    include: ['lib/**/*.test.tsx'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: !process.env.DEBUG,
      instances: [{ browser: browserName }],
    },
  },
})
