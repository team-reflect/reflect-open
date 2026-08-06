import tailwindcss from '@tailwindcss/vite'
import { playwright } from '@vitest/browser-playwright'
import { playwrightCommands } from 'vitest-browser-commands'
import { defineDesktopProject } from './vitest.shared'

const browserName = process.env.REFLECT_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium'

if (process.env.CI) {
  console.log('Running in CI mode with browser:', browserName)
}

export default defineDesktopProject({
  plugins: [tailwindcss(), playwrightCommands()],
  test: {
    name: 'browser',
    include: ['src/**/*.test.tsx'],
    sequence: { groupOrder: 100 },
    setupFiles: ['./src/test-utils/setup-console.ts', './src/test-utils/setup-browser.ts'],
    // Real keyboard focus is a per-page global; parallel test files
    // would steal it from each other.
    fileParallelism: false,
    browser: {
      enabled: true,
      viewport: { width: 900, height: 600 },
      provider: playwright({
        contextOptions: {
          reducedMotion: 'reduce',
          hasTouch: true,
          ...(browserName === 'chromium'
            ? { permissions: ['clipboard-read', 'clipboard-write'] }
            : {}),
        },
      }),
      headless: !process.env.DEBUG,
      instances: [{ browser: browserName }],
    },
  },
})
