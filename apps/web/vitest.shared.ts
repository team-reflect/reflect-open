import { fileURLToPath } from 'node:url'
import { defineProject, type ViteUserConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export function defineDesktopProject(project: {
  plugins?: ViteUserConfig['plugins']
  test: NonNullable<ViteUserConfig['test']>
}): ViteUserConfig {
  return defineProject({
    plugins: [react({ compiler: true }), ...(project.plugins ?? [])],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // A dependency that Vite first sees in the middle of a browser run gets
    // optimized on the spot and reloads the page, which kills the test file
    // in flight. Only a few test files reach these, so name them up front.
    optimizeDeps: {
      include: ['@tauri-apps/api/core'],
    },
    test: {
      globals: false,
      restoreMocks: true,
      retry: process.env.CI ? 3 : 0,
      setupFiles: ['./src/test-utils/setup-console.ts'],
      slowTestThreshold: 10_000,
      ...project.test,
    },
  })
}
