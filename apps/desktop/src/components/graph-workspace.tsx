import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { NoteWindowContent } from '@/components/note-window-content.tsx'
import { WorkspaceContent } from '@/components/workspace-content.tsx'
import { AudioMemoProvider } from '@/providers/audio-memo-provider.tsx'
import { FocusedDailyProvider } from '@/providers/focused-daily-provider.tsx'
import { DeepLinkProvider } from '@/providers/deep-link-provider.tsx'
import { NoteFindProvider } from '@/providers/note-find-provider.tsx'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider.tsx'
import { ShortcutsProvider } from '@/providers/shortcuts-provider.tsx'
import { SidebarProvider } from '@/providers/sidebar-provider.tsx'
import { V1ImportProvider } from '@/providers/v1-import-provider.tsx'
import { RouterProvider } from '@/routing/router.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

interface GraphWorkspaceProps {
  graph: GraphInfo
}

/**
 * The main surface once a graph is open (Plan 06): mounts the per-graph
 * providers — the typed router, the ⌘K palette, and the sidebar state —
 * around {@link WorkspaceContent}. The app opens to today's daily note, the
 * chronological spine. Keyed by the graph root so switching graphs starts a
 * fresh history.
 */
export function GraphWorkspace({ graph }: GraphWorkspaceProps): ReactElement {
  const { deepLinkRouter, window: appWindow } = useAppServices()
  // A note window's first route is its ⌘-clicked target (seeded by the boot
  // hook) — starting on the default today route would flash the daily note
  // until the deep link navigated.
  const initialRoute = appWindow.isMainWindow() ? null : deepLinkRouter.getInitialWindowRoute()
  return (
    <RouterProvider key={graph.root} {...(initialRoute !== null ? { initialRoute } : {})}>
      <PaletteProvider>
        <ShortcutsProvider>
          <NoteTemplatesProvider>
            <SidebarProvider>
              {/* Above the sidebar: a recording must survive the sidebar (and its
                  mic button) unmounting on collapse. */}
              <AudioMemoProvider graph={graph}>
                {/* Inside the router: deep links navigate. */}
                <DeepLinkProvider>
                  {/* Tracks the focused day in the daily stream so the right
                      sidebar describes it, not just the routed day. */}
                  <FocusedDailyProvider>
                    <NoteFindProvider>
                      {/* A ⌘-clicked note window is chrome-free: the
                          routed view only, no sidebar/palette shell.
                          The V1 import lives above the routed views so
                          closing settings can't orphan a running
                          import; main window only — its dialog is the
                          import's single face. */}
                      {appWindow.isMainWindow() ? (
                        <V1ImportProvider>
                          <WorkspaceContent graph={graph} />
                        </V1ImportProvider>
                      ) : (
                        <NoteWindowContent />
                      )}
                    </NoteFindProvider>
                  </FocusedDailyProvider>
                </DeepLinkProvider>
              </AudioMemoProvider>
            </SidebarProvider>
          </NoteTemplatesProvider>
        </ShortcutsProvider>
      </PaletteProvider>
    </RouterProvider>
  )
}
