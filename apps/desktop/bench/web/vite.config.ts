import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { reactWithCompiler } from '../../react-compiler-plugin'

const fake = (name: string): string => fileURLToPath(new URL(`./fakes/${name}`, import.meta.url))

/**
 * Redirects the palette's *relative* imports (`./use-palette-results`,
 * `./note-preview`) — which a path alias can't match — to the harness fakes,
 * by rewriting the resolved module id.
 */
function redirectRelativeFakes(): Plugin {
  const map: Array<{ suffix: string; to: string }> = [
    { suffix: 'command-palette/use-palette-results', to: fake('use-palette-results.ts') },
    { suffix: 'command-palette/note-preview', to: fake('note-preview.tsx') },
  ]
  return {
    name: 'bench-redirect-relative-fakes',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.startsWith('.')) {
        return null
      }
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      if (!resolved) {
        return null
      }
      const resolvedId = resolved.id.replaceAll('\\', '/').replace(/\.(ts|tsx)$/, '')
      const match = map.find((entry) => resolvedId.endsWith(entry.suffix))
      return match ? match.to : null
    },
  }
}

/**
 * Standalone Vite config for the real-Chromium benchmark harness. Mirrors the
 * app's `@` alias and React-compiler plugin (so the compiled output matches
 * production), then overrides the IPC-bound providers and leaves with in-memory
 * fakes so the real memoized components run with a large dataset and no native
 * backend. Benchmark-only.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [redirectRelativeFakes(), reactWithCompiler(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@/providers/graph-provider', replacement: fake('graph-provider.tsx') },
      { find: '@/providers/settings-provider', replacement: fake('settings-provider.tsx') },
      { find: '@', replacement: fileURLToPath(new URL('../../src', import.meta.url)) },
    ],
  },
  server: { port: 5199, strictPort: true },
})
