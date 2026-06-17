import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import { PaletteProvider } from '@/components/command-palette/palette-provider'
import { WorkspaceContent } from '@/components/workspace-content'
import { AssetDescribeProvider } from '@/providers/asset-describe-provider'
import { AudioMemoProvider } from '@/providers/audio-memo-provider'
import { FocusedDailyProvider } from '@/providers/focused-daily-provider'
import { CaptureProvider } from '@/providers/capture-provider'
import { ChatProvider } from '@/providers/chat-provider'
import { ShortcutsProvider } from '@/providers/shortcuts-provider'
import { SidebarProvider } from '@/providers/sidebar-provider'
import { SyncProvider } from '@/providers/sync-provider'
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
  return (
    <RouterProvider key={graph.root}>
      <SyncProvider graph={graph}>
        <PaletteProvider>
          <ShortcutsProvider>
            <SidebarProvider>
              {/* Above the sidebar: a recording must survive the sidebar (and its
                  mic button) unmounting on collapse. */}
              <AudioMemoProvider graph={graph}>
                <CaptureProvider graph={graph}>
                  <AssetDescribeProvider graph={graph}>
                    <ChatProvider graph={graph}>
                      {/* Tracks the focused day in the daily stream so the right
                          sidebar describes it, not just the routed day. */}
                      <FocusedDailyProvider>
                        <WorkspaceContent graph={graph} />
                      </FocusedDailyProvider>
                    </ChatProvider>
                  </AssetDescribeProvider>
                </CaptureProvider>
              </AudioMemoProvider>
            </SidebarProvider>
          </ShortcutsProvider>
        </PaletteProvider>
      </SyncProvider>
    </RouterProvider>
  )
}
