import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { PanelLeft } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { CloudSyncBanner } from '@/components/cloud-sync-banner'
import { CommandPalette } from '@/components/command-palette/command-palette'
import { DailyContextSidebar } from '@/components/context-sidebar/daily-context-sidebar'
import { NoteContextSidebar } from '@/components/context-sidebar/note-context-sidebar'
import { type ContextSidebarTarget } from '@/components/context-sidebar/sidebar-route'
import { EmbeddingsSync } from '@/components/embeddings-sync'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RouteContent } from '@/components/route-content'
import { ShortcutsDialog } from '@/components/shortcuts-dialog'
import { Sidebar } from '@/components/sidebar/sidebar'
import { keybindingFor } from '@/lib/commands/app-commands'
import { cn } from '@/lib/utils'
import { hasMacosTitleBarOverlay } from '@/lib/window-chrome'
import { useDailyContextTarget } from '@/providers/focused-daily-provider'
import { useSidebar } from '@/providers/sidebar-provider'
import { useAppShortcuts } from '@/routing/app-shortcuts'

const TOGGLE_SIDEBAR_BINDING = keybindingFor('sidebar.toggle')

interface WorkspaceContentProps {
  graph: GraphInfo
}

/** The context panel for the route's sidebar target, if it gets one. */
function contextSidebarFor(target: ContextSidebarTarget | null): ReactElement | undefined {
  if (target === null) {
    return undefined
  }
  return target.kind === 'daily' ? (
    <DailyContextSidebar date={target.date} />
  ) : (
    <NoteContextSidebar path={target.path} />
  )
}

/**
 * Everything inside the workspace's providers: the headerless shell — the
 * collapsible workspace sidebar beside the note pane, with the contextual
 * panel on the right for daily and note routes — plus the always-mounted
 * global surfaces (operations status, ⌘K palette, embeddings sync). Split
 * from {@link GraphWorkspace} because these hooks need the providers it
 * mounts.
 */
export function WorkspaceContent({ graph }: WorkspaceContentProps): ReactElement {
  const { collapsed } = useSidebar()
  const commandContext = useAppShortcuts()
  // Daily routes get the day's contextual panel and note routes the note's;
  // search/settings get none (AppShell omits the region when context is absent).
  // In the daily stream the route stays put while focus moves between days, so
  // the panel follows the focused day and snaps back on navigation.
  const contextTarget = useDailyContextTarget()

  return (
    <AppShell
      sidebar={collapsed ? undefined : <Sidebar graph={graph} context={commandContext} />}
      context={contextSidebarFor(contextTarget)}
    >
      <div className="relative flex h-full flex-col">
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Show sidebar"
                onClick={() => commandContext.toggleSidebar()}
                className={cn(
                  'absolute left-3 z-10 rounded-md p-1 text-text-muted transition-colors duration-100 hover:bg-surface-hover hover:text-text-secondary',
                  // Clear the overlaid macOS title bar: the traffic lights float
                  // exactly where this button otherwise sits.
                  hasMacosTitleBarOverlay ? 'top-9' : 'top-2.5',
                )}
              >
                <PanelLeft aria-hidden strokeWidth={1.75} className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Show sidebar{' '}
              {TOGGLE_SIDEBAR_BINDING && <ShortcutKeys binding={TOGGLE_SIDEBAR_BINDING} />}
            </TooltipContent>
          </Tooltip>
        ) : null}

        {graph.cloudSync ? <CloudSyncBanner provider={graph.cloudSync} /> : null}

        <div className="min-h-0 flex-1">
          <RouteContent />
        </div>

        <CommandPalette context={commandContext} />
        <ShortcutsDialog />
        <EmbeddingsSync />
      </div>
    </AppShell>
  )
}
