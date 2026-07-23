import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig, type ViteUserConfig } from 'vitest/config'
import { reactWithCompiler } from './react-compiler-plugin'

// Test routing: `.test.tsx` needs a DOM and runs in a real browser (chromium
// by default; REFLECT_TEST_BROWSER=webkit switches to WebKit, DEBUG=1 opens a
// headed window); `.test.ts` is pure logic and runs in node. See
// docs/contributing/testing.md.
const browserName = process.env.REFLECT_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium'

if (process.env.CI) {
  console.log('Running in CI mode with browser:', browserName)
}

function desktopProject(project: {
  plugins?: ViteUserConfig['plugins']
  test: NonNullable<ViteUserConfig['test']>
}): ViteUserConfig {
  return {
    plugins: [reactWithCompiler(), ...(project.plugins ?? [])],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    test: {
      globals: false,
      maxConcurrency: 1,
      retry: process.env.CI ? 3 : 0,
      setupFiles: ['./src/test-utils/setup-console.ts'],
      ...project.test,
    },
  }
}

export default defineConfig({
  test: {
    slowTestThreshold: 10_000,
    projects: [
      desktopProject({
        plugins: [tailwindcss()],
        test: {
          name: 'browser',
          include: ['src/**/*.test.tsx'],
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
                permissions:
                  browserName === 'chromium' ? ['clipboard-read', 'clipboard-write'] : undefined,
              },
            }),
            headless: !process.env.DEBUG,
            instances: [{ browser: browserName }],
          },
        },
      }),
      desktopProject({
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
        },
      }),
    ],
  },
})
