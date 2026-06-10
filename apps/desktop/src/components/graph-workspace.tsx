import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { PanelLeft } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { CommandPalette } from '@/components/command-palette/command-palette'
import { EmbeddingsSync } from '@/components/embeddings-sync'
import { PaletteProvider } from '@/components/command-palette/palette-provider'
import { DailyContextSidebar } from '@/components/daily-sidebar/daily-context-sidebar'
import { dailySidebarDate } from '@/components/daily-sidebar/sidebar-route'
import { RouteContent } from '@/components/route-content'
import { Sidebar } from '@/components/sidebar/sidebar'
import { useToday } from '@/lib/use-today'
import { OperationsStatus } from '@/components/operations-status'
import { SidebarProvider, useSidebar } from '@/providers/sidebar-provider'
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
 * The main surface once a graph is open: the sidebar + note pane around the
 * route-driven content (Plan 06). The app opens to today's daily note — the
 * chronological spine — and all navigation goes through the typed router.
 * Keyed by the graph root so switching graphs starts a fresh history.
 */
export function GraphWorkspace({ graph }: GraphWorkspaceProps): ReactElement {
  return (
    <RouterProvider key={graph.root}>
      <PaletteProvider>
        <SidebarProvider>
          <WorkspaceContent graph={graph} />
        </SidebarProvider>
      </PaletteProvider>
    </RouterProvider>
  )
}

function WorkspaceContent({ graph }: GraphWorkspaceProps): ReactElement {
  const { collapsed } = useSidebar()
  const { route } = useRouter()
  const commandContext = useAppShortcuts()
  const today = useToday()
  // Daily routes get the contextual panel on the right; note/search/settings
  // routes get none (AppShell omits the region entirely when context is absent).
  const sidebarDate = dailySidebarDate(route, today)

  const cloudLabel = graph.cloudSync ? (CLOUD_LABELS[graph.cloudSync] ?? graph.cloudSync) : null

  return (
    <AppShell
      sidebar={collapsed ? undefined : <Sidebar graph={graph} context={commandContext} />}
      context={sidebarDate !== null ? <DailyContextSidebar date={sidebarDate} /> : undefined}
    >
      <div className="relative flex h-full flex-col">
        {collapsed ? (
          <button
            type="button"
            aria-label="Show sidebar"
            title="Show sidebar"
            onClick={() => commandContext.toggleSidebar()}
            className="absolute top-2.5 left-3 z-10 rounded-md p-1 text-[color:var(--text-muted)] transition-colors duration-100 hover:bg-[var(--surface-hover)] hover:text-[color:var(--text-secondary)]"
          >
            <PanelLeft aria-hidden strokeWidth={1.75} className="size-4" />
          </button>
        ) : null}

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
