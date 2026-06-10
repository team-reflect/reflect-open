import { useCallback, type ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { Settings } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { CommandPalette } from '@/components/command-palette/command-palette'
import { EmbeddingsSync } from '@/components/embeddings-sync'
import { PaletteProvider } from '@/components/command-palette/palette-provider'
import { RouteContent } from '@/components/route-content'
import { useAppVersion } from '@/hooks/use-app-version'
import { OperationsStatus } from '@/components/operations-status'
import { useGraph } from '@/providers/graph-provider'
import { useTheme } from '@/providers/theme-provider'
import { useAppShortcuts } from '@/routing/app-shortcuts'
import { RouterProvider, useRouter } from '@/routing/router'

const CLOUD_LABELS: Record<string, string> = {
  icloud: 'iCloud Drive',
  dropbox: 'Dropbox',
  googleDrive: 'Google Drive',
  oneDrive: 'OneDrive',
}

interface GraphWorkspaceProps {
  graph: GraphInfo
}

/**
 * The main surface once a graph is open: the shell + header around the
 * route-driven content (Plan 06). The app opens to today's daily note — the
 * chronological spine — and all navigation goes through the typed router.
 * Keyed by the graph root so switching graphs starts a fresh history.
 */
export function GraphWorkspace({ graph }: GraphWorkspaceProps): ReactElement {
  return (
    <RouterProvider key={graph.root}>
      <PaletteProvider>
        <WorkspaceContent graph={graph} />
      </PaletteProvider>
    </RouterProvider>
  )
}

function WorkspaceContent({ graph }: GraphWorkspaceProps): ReactElement {
  const { resolvedTheme, setTheme } = useTheme()
  const { indexing } = useGraph()
  const { navigate } = useRouter()
  const version = useAppVersion()
  const commandContext = useAppShortcuts()

  const toggleTheme = useCallback((): void => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }, [resolvedTheme, setTheme])

  const cloudLabel = graph.cloudSync ? (CLOUD_LABELS[graph.cloudSync] ?? graph.cloudSync) : null

  return (
    <AppShell
      rail={
        <span className="text-xs font-semibold text-[color:var(--text-secondary)]">R</span>
      }
      sidebar={
        <div className="p-4 text-sm text-[color:var(--text-secondary)]">Context</div>
      }
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-black/10 px-6 py-3 dark:border-white/10">
          <h1 className="truncate text-sm font-semibold" title={graph.root}>
            {graph.name}
          </h1>
          <div className="flex items-center gap-3">
            {indexing ? (
              <span
                role="status"
                className="text-xs text-[color:var(--text-muted)] motion-safe:animate-pulse"
              >
                Indexing…
              </span>
            ) : null}
            <span className="text-xs text-[color:var(--text-muted)]">v{version ?? '—'}</span>
            <button
              type="button"
              onClick={toggleTheme}
              className="rounded-md border border-black/10 px-2.5 py-1 text-xs font-medium dark:border-white/10"
            >
              {resolvedTheme === 'dark' ? 'Light' : 'Dark'} mode
            </button>
            <button
              type="button"
              aria-label="Open settings"
              title="Settings (⌘,)"
              onClick={() => navigate({ kind: 'settings' })}
              className="rounded-md border border-black/10 p-1.5 text-[color:var(--text-secondary)] dark:border-white/10"
            >
              <Settings aria-hidden className="size-3.5" />
            </button>
          </div>
        </header>

        {cloudLabel ? (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-700 dark:text-amber-300">
            This graph is inside {cloudLabel}. Reflect syncs via GitHub — a cloud-synced
            folder is unsupported and can corrupt the local index. Consider moving it to a
            non-synced location.
          </div>
        ) : null}

        <div className="min-h-0 flex-1">
          <RouteContent />
        </div>

        <OperationsStatus />
        <CommandPalette context={commandContext} />
        <EmbeddingsSync />
      </div>
    </AppShell>
  )
}
