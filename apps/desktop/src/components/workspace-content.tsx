import { useEffect, type ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { AppShell } from '@/components/app-shell'
import { CommandPalette } from '@/components/command-palette/command-palette'
import { DailyContextSidebar } from '@/components/context-sidebar/daily-context-sidebar'
import { NoteContextSidebar } from '@/components/context-sidebar/note-context-sidebar'
import type { ContextSidebarTarget } from '@/components/context-sidebar/sidebar-route'
import { EmbeddingsSync } from '@/components/embeddings-sync'
import { ErrorBoundary } from '@/components/error-boundary'
import { NoteFindBar } from '@/components/note-find-bar'
import { PdfSidebarBlock } from '@/components/preview/pdf-sidebar-block'
import { PreviewPanel } from '@/components/preview/preview-panel'
import { RouteContent } from '@/components/route-content'
import { ShortcutsDialog } from '@/components/shortcuts-dialog'
import { Sidebar } from '@/components/sidebar/sidebar'
import { SidebarResizeHandle } from '@/components/sidebar-resize-handle'
import { TemplateCreateDialog } from '@/components/templates/template-create-dialog'
import { TemplatePicker } from '@/components/templates/template-picker'
import { useDailyContextTarget } from '@/providers/focused-daily-provider'
import { usePdfSidebarView } from '@/providers/pdf-sidebar-view-provider'
import { usePreviewPanel } from '@/providers/preview-panel-provider'
import { useSidebar } from '@/providers/sidebar-provider'
import { useAppShortcuts } from '@/routing/app-shortcuts'

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

/** The crash fallback for the preview pane: a quiet alert, nothing more. */
function previewPanelFallback(message: string): ReactElement {
  return (
    <div role="alert" className="p-3.5 text-xs text-text-muted">
      {message}
    </div>
  )
}

/**
 * Everything inside the workspace's providers: the headerless shell — the
 * collapsible workspace and contextual sidebars beside the note pane — plus
 * the always-mounted global surfaces (operations status, ⌘K palette,
 * embeddings sync). Split
 * from {@link GraphWorkspace} because these hooks need the providers it
 * mounts — including the sidebar-stack and PDF session providers above it.
 */
export function WorkspaceContent({ graph }: WorkspaceContentProps): ReactElement {
  const { collapsed } = useSidebar()
  const commandContext = useAppShortcuts()
  // Daily routes get the day's contextual panel and note routes the note's;
  // search/settings get none (AppShell omits the region when context is absent).
  // In the daily stream the route stays put while focus moves between days, so
  // the panel follows the focused day and snaps back on navigation.
  const contextTarget = useDailyContextTarget()
  // An open preview panel renders as a split pane inside the main column —
  // the user's explicit focus (a PDF/note opened from a link) — while the
  // context aside keeps the route's daily/note panel. Navigation clears it
  // (PreviewPanelProvider), so the split pane closes and the note goes full
  // width again.
  const { target: previewTarget, close: closePreview } = usePreviewPanel()

  // Sidebar stack: opening a PDF (false→true) pushes the PDF panel on top;
  // closing it (true→false) pops back to the document panel. Returning to the
  // document panel manually while the PDF stays open is never overridden by
  // re-renders (applyTarget only switches on an edge change).
  const { view, applyTarget } = usePdfSidebarView()
  useEffect(() => {
    applyTarget(previewTarget?.kind === 'pdf')
  }, [previewTarget?.kind, applyTarget])

  const routeContext = contextSidebarFor(contextTarget)
  const pdfPanelOpen = view === 'pdf' && previewTarget?.kind === 'pdf'
  const pdfContextBlock = pdfPanelOpen ? (
    <ErrorBoundary fallback={previewPanelFallback}>
      <PdfSidebarBlock assetPath={previewTarget.assetPath} />
    </ErrorBoundary>
  ) : null
  // The PDF panel takes over the context slot exclusively; otherwise the
  // document panel shows. The document panel's SidebarSection state lives in
  // sessionStorage and is untouched while hidden, so it restores as-is when
  // the document view returns.
  const context = pdfContextBlock ?? routeContext

  return (
    <AppShell
      sidebar={collapsed ? undefined : <Sidebar graph={graph} context={commandContext} />}
      sidebarEdge={<SidebarResizeHandle panel="workspace" />}
      context={collapsed ? undefined : context}
      contextEdge={<SidebarResizeHandle panel="context" />}
    >
      <div className="relative flex h-full flex-col">
        <div className="min-h-0 flex-1">
          {/* The note pane and the preview pane share the main column as a
              vertical split; the pane appears only while a target is open and
              never below a breakpoint — it is the user's explicit focus. The
              editor keeps its EDITOR_MIN_WIDTH_PX reserve via the resize
              budget (use-sidebar-resize), not via CSS here. */}
          <div className="flex h-full min-h-0">
            <div className="min-w-0 flex-1">
              <RouteContent />
            </div>
            {previewTarget !== null ? (
              <aside
                id="preview-panel"
                aria-label="Preview"
                className="relative h-full w-[var(--preview-panel-width)] shrink-0 border-l border-border bg-surface-sunken"
              >
                <SidebarResizeHandle panel="preview" />
                <div className="h-full overflow-hidden">
                  <ErrorBoundary fallback={previewPanelFallback}>
                    <PreviewPanel target={previewTarget} onClose={closePreview} />
                  </ErrorBoundary>
                </div>
              </aside>
            ) : null}
          </div>
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
