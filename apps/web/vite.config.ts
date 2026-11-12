import { sentryVitePlugin } from '@sentry/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// The single version source; apps/tauri/tauri.conf.json's `version` and the
// iOS build also read it.
import pkg from './package.json' with { type: 'json' }

// `TAURI_ENV_PLATFORM` picks the platform root and the output directory. The
// Tauri CLI sets it for desktop builds; `apps/ios` sets it to `ios`.
const platform: 'mobile' | 'desktop' | 'unknown' = (() => {
  const env = process.env.TAURI_ENV_PLATFORM
  if (!env) {
    return 'unknown'
  }

  switch (env) {
    case 'ios':
    case 'android':
      return 'mobile'
    case 'windows':
    case 'darwin':
    case 'linux':
      return 'desktop'
  }

  // The Tauri CLI sets only the values above, so any other value is a typo.
  throw new Error(`Unknown environment variable TAURI_ENV_PLATFORM: ${env}`)
})()

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [
    react({
      compiler: {
        reportDiagnostics: true,
        // Fail the build on any component or hook the compiler skips. Dev keeps warnings so a work-in-progress edit does not break HMR.
        panicThreshold: command === 'build' ? 'all_errors' : 'none',
      },
    }),

    tailwindcss(),
    sentryVitePlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: 'reflect-64',
      project: 'reflect-open',
      telemetry: false,
      release: {
        name: `reflect@${pkg.version}`,
      },
      sourcemaps: {
        filesToDeleteAfterUpload: [`./dist/${platform}/**/*.map`],
      },
    }),
  ],

  // The JS target lowers syntax that Safari 16.4 introduced (class static blocks).
  // If the CSS target is below Safari 17.5, Lightning CSS downlevels `light-dark()` to a broken polyfill.
  build: {
    outDir: `dist/${platform}`,
    target: 'safari16',
    cssTarget: 'safari17.5',
    sourcemap: 'hidden',
  },

  resolve: {
    alias: {
      '@platform-root': fileURLToPath(
        new URL(`./src/platform-root.${platform}.tsx`, import.meta.url),
      ),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  // Expose the Tauri CLI's build-time TAURI_ENV_* vars (e.g. the target
  // platform, which gates desktop-only surfaces like the updater).
  envPrefix: ['VITE_', 'TAURI_ENV_'],

  // The dev bridge's SQLite (dev-only, behind `?platform=ios`) locates its
  // .wasm relative to its own module URL; esbuild pre-bundling would relocate
  // the module into .vite/deps and break that lookup.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },

  // Keep the Tauri CLI's Rust output on screen during `tauri dev`.
  clearScreen: false,
  // `devUrl` in apps/tauri/tauri.conf.json and the iOS dev scheme expect this
  // fixed port; fail if it is not available.
  server: {
    port: 1420,
    strictPort: true,
    forwardConsole: {
      unhandledErrors: true,
      logLevels: ['error', 'warn', 'info', 'log', 'debug'],
    },
  },
}))
