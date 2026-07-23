import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { playwright } from '@vitest/browser-playwright'
import { configDefaults, defineConfig, type ViteUserConfig } from 'vitest/config'
import { reactWithCompiler } from './react-compiler-plugin'

// Test routing: `.test.tsx` needs a DOM and runs in a real browser (chromium
// by default; REFLECT_TEST_BROWSER=webkit switches to WebKit, DEBUG=1 opens a
// headed window); `.test.ts` is pure logic and runs in node. The exceptions
// below are `.test.ts` files that still drive the DOM. See
// docs/contributing/testing.md.
const browserName = process.env.REFLECT_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium'

/** `.test.ts` files that drive the DOM, so they run in the browser project. */
const DOM_DRIVING_LOGIC_TESTS = [
  'src/editor/formatting-toolbar-store.test.ts',
  'src/editor/open-external-link.test.ts',
  'src/editor/use-template-slash-items.test.ts',
  'src/hooks/note-row-overlay.test.ts',
  'src/hooks/use-audio-recorder.test.ts',
  'src/hooks/use-double-tap.test.ts',
  'src/hooks/use-note-window-title.test.ts',
  'src/lib/asset-describe-controller.test.ts',
  'src/lib/background-flush.test.ts',
  'src/lib/background-reconciler.test.ts',
  'src/lib/backup-controller.test.ts',
  'src/lib/capture-controller.test.ts',
  'src/lib/chat-attachments.test.ts',
  'src/lib/icloud-controller.test.ts',
  'src/lib/notes/use-note-trash.test.ts',
  'src/lib/operations.test.ts',
  'src/lib/quit-flush.test.ts',
  'src/lib/selection/use-list-selection.test.ts',
  'src/lib/semantic.test.ts',
  'src/lib/tasks/recently-completed.test.ts',
  'src/lib/tasks/use-task-editor-finalizer.test.ts',
  'src/lib/tasks/use-task-keyboard.test.ts',
  'src/lib/tasks/use-task-selection.test.ts',
  'src/lib/transcription-reconciler.test.ts',
  'src/lib/use-today.test.ts',
  'src/lib/windows/open-in-new-window.test.ts',
  'src/mobile/use-arrival-focus.test.ts',
  'src/mobile/use-daily-arrivals.test.ts',
  'src/mobile/use-day-carousel.test.ts',
  'src/mobile/use-keyboard.test.ts',
  'src/mobile/use-native-audio-recorder.test.ts',
  'src/mobile/use-scroll-restore.test.ts',
  'src/mobile/use-swipe-target.test.ts',
  'src/mobile/use-task-haptics.test.ts',
  'src/mobile/use-task-sheet-finalizer.test.ts',
  'src/mobile/use-week-strip.test.ts',
  'src/providers/use-note-window-boot.test.ts',
]

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
          include: ['src/**/*.test.tsx', ...DOM_DRIVING_LOGIC_TESTS],
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
          exclude: [...configDefaults.exclude, ...DOM_DRIVING_LOGIC_TESTS],
        },
      }),
    ],
  },
})
