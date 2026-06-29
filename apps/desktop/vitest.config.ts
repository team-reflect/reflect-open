import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { playwright } from '@vitest/browser-playwright'
import { configDefaults, defineConfig } from 'vitest/config'
import { reactWithCompiler } from './react-compiler-plugin'

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
}

// Two test projects, split by what each test needs:
//
// - `browser` runs anything that touches the DOM or `window` (React components,
//   the editor, virtua lists, focus/online reconcilers) in a real Chromium via
//   Playwright. A test opts in by ending its filename with `.browser.test.ts(x)`;
//   it queries the page with `vitest/browser` locators and `expect.element(...)`.
// - `node` runs the rest (pure logic) in Node. No jsdom: a test that needs a DOM
//   is a `.browser.test` instead.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [reactWithCompiler()],
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          globals: false,
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, 'src/**/*.browser.test.{ts,tsx}'],
        },
      },
      {
        plugins: [reactWithCompiler(), tailwindcss()],
        resolve: { alias },
        // Pre-bundle the heavy deps the DOM tests pull in, so Vite does not
        // re-optimize (and reload the page, failing the run) mid-suite.
        optimizeDeps: {
          include: [
            'react',
            'react-dom',
            'react-dom/client',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            '@tanstack/react-query',
            'virtua',
            'date-fns',
            'lucide-react',
            'radix-ui',
            'class-variance-authority',
            'ulidx',
            'zod',
            '@meowdown/core',
            '@meowdown/react',
            '@tauri-apps/api/core',
            '@tauri-apps/plugin-dialog',
            '@tauri-apps/plugin-http',
            '@tauri-apps/plugin-opener',
          ],
        },
        test: {
          name: 'browser',
          globals: false,
          // Run browser test files one at a time. Many concurrent Chromium pages
          // overload the runner (15s actionability timeouts) and let window-level
          // listeners/state from one file bleed into another's timing.
          fileParallelism: false,
          // Real-browser layout/scroll makes the virtua tests timing-sensitive;
          // retry on CI to absorb the occasional cold-start flake.
          retry: process.env.CI ? 3 : 0,
          include: ['src/**/*.browser.test.{ts,tsx}'],
          setupFiles: ['./vitest.setup.browser.ts'],
          browser: {
            enabled: true,
            headless: true,
            // A desktop-sized viewport: this is a desktop app, and narrow
            // viewports collapse responsive columns (e.g. the All Notes snippet),
            // hiding elements the tests need to see and click.
            viewport: { width: 1280, height: 800 },
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
