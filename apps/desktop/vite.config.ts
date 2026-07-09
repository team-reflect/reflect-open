import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { reactWithCompiler } from './react-compiler-plugin'

// @ts-expect-error process is a Node.js global available in the Vite config context
const host = process.env.TAURI_DEV_HOST
// @ts-expect-error process is a Node.js global available in the Vite config context
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN
// @ts-expect-error process is a Node.js global available in the Vite config context
const sentryRelease = process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE ?? process.env.GITHUB_SHA

// https://vite.dev/config/
export default defineConfig(async ({ command, mode }) => {
  // @ts-expect-error process is a Node.js global available in the Vite config context
  const sentryEnabled =
    process.env.VITE_SENTRY_ENABLED ??
    (sentryAuthToken && command === 'build' && mode === 'production' ? 'true' : '')

  return {
    plugins: [
      reactWithCompiler(),
      tailwindcss(),
      sentryAuthToken && command === 'build'
        ? sentryVitePlugin({
            org: 'reflect-64',
            project: 'reflect-open',
            authToken: sentryAuthToken,
            telemetry: false,
            ...(sentryRelease ? { release: { name: sentryRelease } } : {}),
          })
        : null,
    ],

    // If the target is below Safari 17.5, Lightning CSS downlevels `light-dark()` to a broken polyfill.
    build: { cssTarget: 'safari17.5', sourcemap: true },

    define: {
      'import.meta.env.VITE_SENTRY_ENABLED': JSON.stringify(sentryEnabled),
      'import.meta.env.VITE_SENTRY_RELEASE': JSON.stringify(sentryRelease ?? ''),
    },

    resolve: {
      alias: {
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

    // Vite options tailored for Tauri development, applied in `tauri dev`/`tauri build`.
    //
    // 1. prevent Vite from obscuring Rust errors
    clearScreen: false,
    // 2. Tauri expects a fixed port; fail if it is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: 'ws',
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ['**/src-tauri/**'],
      },
    },
  }
})
