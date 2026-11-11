import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { AppShell } from '@/components/app-shell.tsx'
import { CommandPalette } from '@/components/command-palette/command-palette.tsx'
import { DailyContextSidebar } from '@/components/context-sidebar/daily-context-sidebar.tsx'
import { NoteContextSidebar } from '@/components/context-sidebar/note-context-sidebar.tsx'
import type { ContextSidebarTarget } from '@/components/context-sidebar/sidebar-route.ts'
import { EmbeddingsSync } from '@/components/embeddings-sync.tsx'
import { NoteFindBar } from '@/components/note-find-bar.tsx'
import { RouteContent } from '@/components/route-content.tsx'
import { ShortcutsDialog } from '@/components/shortcuts-dialog.tsx'
import { Sidebar } from '@/components/sidebar/sidebar.tsx'
import { SidebarResizeHandle } from '@/components/sidebar-resize-handle.tsx'
import { TemplateCreateDialog } from '@/components/templates/template-create-dialog.tsx'
import { TemplatePicker } from '@/components/templates/template-picker.tsx'
import { useDailyContextTarget } from '@/providers/focused-daily-provider.tsx'
import { useSidebar } from '@/providers/sidebar-provider.tsx'
import { useAppShortcuts } from '@/routing/app-shortcuts.ts'

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
 * collapsible workspace and contextual sidebars beside the note pane — plus
 * the always-mounted global surfaces (operations status, ⌘K palette,
 * embeddings sync). Split
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
      sidebarEdge={<SidebarResizeHandle panel="workspace" />}
      context={collapsed ? undefined : contextSidebarFor(contextTarget)}
      contextEdge={<SidebarResizeHandle panel="context" />}
    >
      <div className="relative flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <RouteContent />
        </div>

        <NoteFindBar />
        <CommandPalette context={commandContext} />
        <ShortcutsDialog />
        <TemplatePicker context={commandContext} />
        <TemplateCreateDialog context={commandContext} />
        <EmbeddingsSync />
      </div>
    </AppShell>
  )
}
