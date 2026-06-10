import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { PanelLeft } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { CloudSyncBanner } from '@/components/cloud-sync-banner'
import { CommandPalette } from '@/components/command-palette/command-palette'
import { contextSidebarFor } from '@/components/context-sidebar/sidebar-route'
import { NoteContextSidebar } from '@/components/context-sidebar/note-context-sidebar'
import { DailyContextSidebar } from '@/components/daily-sidebar/daily-context-sidebar'
import { EmbeddingsSync } from '@/components/embeddings-sync'
import { OperationsStatus } from '@/components/operations-status'
import { RouteContent } from '@/components/route-content'
import { Sidebar } from '@/components/sidebar/sidebar'
import { useToday } from '@/lib/use-today'
import { useSidebar } from '@/providers/sidebar-provider'
import { useAppShortcuts } from '@/routing/app-shortcuts'
import { useRouter } from '@/routing/router'

interface WorkspaceContentProps {
  graph: GraphInfo
}

/**
 * Everything inside the workspace's providers: the headerless shell — the
 * collapsible workspace sidebar beside the note pane, with the contextual
 * panel on the right for daily and note routes — plus the always-mounted
 * global surfaces (operations status, ⌘K palette, embeddings sync). Split from
 * {@link GraphWorkspace} because these hooks need the providers it mounts.
 */
export function WorkspaceContent({ graph }: WorkspaceContentProps): ReactElement {
  const { collapsed } = useSidebar()
  const { route } = useRouter()
  const commandContext = useAppShortcuts()
  const today = useToday()
  // Daily routes get the day's contextual panel on the right, note routes the
  // note's (backlinks + similar notes); search/settings get none (AppShell
  // omits the region entirely when context is absent).
  const contextTarget = contextSidebarFor(route, today)
  const contextSidebar =
    contextTarget === null ? undefined : contextTarget.kind === 'daily' ? (
      <DailyContextSidebar date={contextTarget.date} />
    ) : (
      <NoteContextSidebar path={contextTarget.path} />
    )

  return (
    <AppShell
      sidebar={collapsed ? undefined : <Sidebar graph={graph} context={commandContext} />}
      context={contextSidebar}
    >
      <div className="relative flex h-full flex-col">
        {collapsed ? (
          <button
            type="button"
            aria-label="Show sidebar"
            title="Show sidebar"
            onClick={() => commandContext.toggleSidebar()}
            className="absolute top-2.5 left-3 z-10 rounded-md p-1 text-text-muted transition-colors duration-100 hover:bg-surface-hover hover:text-text-secondary"
          >
            <PanelLeft aria-hidden strokeWidth={1.75} className="size-4" />
          </button>
        ) : null}

        {graph.cloudSync ? <CloudSyncBanner provider={graph.cloudSync} /> : null}

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
