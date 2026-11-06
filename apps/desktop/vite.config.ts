import { sentryVitePlugin } from '@sentry/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
// The single version source; tauri.conf.json's `version` also points here.
import pkg from './package.json' with { type: 'json' }

const host: string | undefined = process.env.TAURI_DEV_HOST
const port = 1420
// `REFLECT_DEV_HTTPS=1 pnpm dev` serves self-signed HTTPS on every interface, so a
// phone on the LAN gets a secure context (`crypto.randomUUID`, `crypto.subtle`).
const devHttps = process.env.REFLECT_DEV_HTTPS === '1'

const platform: 'mobile' | 'desktop' | '' = (() => {
  const env = process.env.TAURI_ENV_PLATFORM
  if (!env) {
    return ''
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

  throw new Error(`Unknown environment variable TAURI_ENV_PLATFORM: ${env}`)
})()

// Prints the swipe log lines the page POSTs to `/__swipe-log`, so the log
// reaches this terminal without Web Inspector or the HMR websocket, and
// appends them to `swipe-log.txt` next to this file (every dev server shares it).
function swipeLogPlugin(): Plugin {
  const file = fileURLToPath(new URL('./swipe-log.txt', import.meta.url))
  return {
    name: 'swipe-log',
    apply: 'serve',
    configureServer(server) {
      appendFileSync(file, `==== server start ${new Date().toISOString()}\n`)
      server.config.logger.info(`[swipe-log] appending to ${file}`)
      server.middlewares.use('/__swipe-log', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => {
          body += chunk
        })
        req.on('end', () => {
          for (const line of body.split('\n')) {
            process.stdout.write(`[swipe] ${line}\n`)
          }
          appendFileSync(file, `${body}\n`)
          res.statusCode = 204
          res.end()
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [
    ...(devHttps ? [basicSsl()] : []),
    swipeLogPlugin(),
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
        filesToDeleteAfterUpload: ['./dist/**/*.map'],
      },
    }),
  ],

  // The JS target lowers syntax that Safari 16.4 introduced (class static blocks).
  // If the CSS target is below Safari 17.5, Lightning CSS downlevels `light-dark()` to a broken polyfill.
  build: { target: 'safari16', cssTarget: 'safari17.5', sourcemap: 'hidden' },

  resolve: {
    alias: {
      '@platform-root': fileURLToPath(
        new URL(
          platform === 'mobile'
            ? './src/platform-root.mobile.tsx'
            : platform === 'desktop'
              ? './src/platform-root.desktop.tsx'
              : './src/platform-root.unknown.tsx',
          import.meta.url,
        ),
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

  // Vite options tailored for Tauri development, applied in `tauri dev`/`tauri build`.
  //
  // 1. prevent Vite from obscuring Rust errors
  clearScreen: false,
  // 2. Tauri expects a fixed port; fail if it is not available
  server: {
    port,
    strictPort: true,
    host: host || devHttps,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
    forwardConsole: {
      unhandledErrors: true,
      logLevels: ['error', 'warn', 'info', 'log', 'debug'],
    },
    ...(host
      ? {
          ws: { host, port },
        }
      : {}),
  },
}))
