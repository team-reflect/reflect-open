import { useCallback, useEffect, type ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { AppShell } from '@/components/app-shell'
import { CommandPalette } from '@/components/command-palette/command-palette'
import { PaletteProvider, usePalette } from '@/components/command-palette/palette-provider'
import { DailyStream } from '@/components/daily-stream'
import { NotePane } from '@/components/note-pane'
import { useAppVersion } from '@/hooks/use-app-version'
import { isIsoDate } from '@/lib/dates'
import { useToday } from '@/lib/use-today'
import { OperationsStatus } from '@/components/operations-status'
import { useGraph } from '@/providers/graph-provider'
import { useTheme } from '@/providers/theme-provider'
import { useAppShortcuts } from '@/routing/app-shortcuts'
import { RouterProvider, useRouter } from '@/routing/router'
import { ScrollRestored } from '@/routing/scroll-restore'

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
      </div>
    </AppShell>
  )
}

/**
 * `search/:query` is a deep-link target, not a second search surface (decided
 * 2026-06-09): arriving opens the ⌘K palette pre-filled over the stream.
 */
function SearchRoute({ query, today }: { query: string; today: string }): ReactElement {
  const { openPalette } = usePalette()
  const { arrivalSeq, entryId } = useRouter()
  // Keyed on the *arrival*, not just the value (the daily stream's lesson):
  // re-navigating to the same search route bumps arrivalSeq without a remount,
  // and back/forward changes entryId without bumping arrivalSeq — both are
  // arrivals, and arriving on search opens the palette (decided).
  useEffect(() => {
    openPalette(query)
  }, [query, arrivalSeq, entryId, openPalette])
  return <DailyStream targetDate={today} />
}

/** Route → view. `today` tracks the live clock — midnight re-renders it. */
function RouteContent(): ReactElement {
  const { route } = useRouter()
  const today = useToday()
  switch (route.kind) {
    case 'today':
      return <DailyStream targetDate={today} />
    case 'daily':
      // A malformed date (impossible calendar day) anchors to today instead of
      // letting dailyPath throw mid-render.
      return <DailyStream targetDate={isIsoDate(route.date) ? route.date : today} />
    case 'note':
      return (
        <ScrollRestored className="h-full overflow-auto px-6 py-8">
          <div className="mx-auto w-full max-w-2xl">
            <NotePane path={route.path} lazy autoFocus />
          </div>
        </ScrollRestored>
      )
    case 'search':
      return <SearchRoute query={route.query} today={today} />
  }
}
