import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { PaletteProvider } from '@/components/command-palette/palette-provider'
import { NoteWindowContent } from '@/components/note-window-content'
import { WorkspaceContent } from '@/components/workspace-content'
import { getInitialWindowRoute } from '@/lib/windows/initial-window-route'
import { isMainWindow } from '@/lib/windows/window-role'
import { AssetDescribeProvider } from '@/providers/asset-describe-provider'
import { AttachmentCatalogProvider } from '@/providers/attachment-catalog-provider'
import { AudioMemoProvider } from '@/providers/audio-memo-provider'
import { FocusedDailyProvider } from '@/providers/focused-daily-provider'
import { CaptureProvider } from '@/providers/capture-provider'
import { ChatProvider } from '@/providers/chat-provider'
import { DeepLinkProvider } from '@/providers/deep-link-provider'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider'
import { ShortcutsProvider } from '@/providers/shortcuts-provider'
import { SidebarProvider } from '@/providers/sidebar-provider'
import { SyncProvider } from '@/providers/sync-provider'
import { V1ImportProvider } from '@/providers/v1-import-provider'
import { RouterProvider } from '@/routing/router'

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
  // A note window's first route is its ⌘-clicked target (seeded by the boot
  // hook) — starting on the default today route would flash the daily note
  // until the deep link navigated.
  const initialRoute = isMainWindow() ? null : getInitialWindowRoute()
  return (
    <RouterProvider key={graph.root} {...(initialRoute !== null ? { initialRoute } : {})}>
      <AttachmentCatalogProvider
        key={`${graph.root}:${graph.generation}`}
        generation={graph.generation}
      >
        <SyncProvider graph={graph}>
        <PaletteProvider>
          <ShortcutsProvider>
            <NoteTemplatesProvider>
              <SidebarProvider>
                {/* Above the sidebar: a recording must survive the sidebar (and its
                    mic button) unmounting on collapse. */}
                <AudioMemoProvider graph={graph}>
                  <CaptureProvider graph={graph}>
                    {/* Inside the router (deep links navigate) and beside capture
                        (deep-link writes spool into the same inbox drain). */}
                    <DeepLinkProvider graph={graph}>
                      <AssetDescribeProvider graph={graph}>
                        <ChatProvider graph={graph}>
                          {/* Tracks the focused day in the daily stream so the right
                              sidebar describes it, not just the routed day. */}
                          <FocusedDailyProvider>
                            {/* A ⌘-clicked note window is chrome-free: the
                                routed view only, no sidebar/palette shell.
                                The V1 import lives above the routed views so
                                closing settings can't orphan a running
                                import; main window only — its dialog is the
                                import's single face. */}
                            {isMainWindow() ? (
                              <V1ImportProvider graph={graph}>
                                <WorkspaceContent graph={graph} />
                              </V1ImportProvider>
                            ) : (
                              <NoteWindowContent />
                            )}
                          </FocusedDailyProvider>
                        </ChatProvider>
                      </AssetDescribeProvider>
                    </DeepLinkProvider>
                  </CaptureProvider>
                </AudioMemoProvider>
              </SidebarProvider>
            </NoteTemplatesProvider>
          </ShortcutsProvider>
        </PaletteProvider>
        </SyncProvider>
      </AttachmentCatalogProvider>
    </RouterProvider>
  )
}
