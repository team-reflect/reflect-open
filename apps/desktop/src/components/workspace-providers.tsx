import type { ReactElement, ReactNode } from 'react'
import type { GraphInfo } from '@reflect/core'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { AudioMemoProvider } from '@/providers/audio-memo-provider.tsx'
import { FocusedDailyProvider } from '@/providers/focused-daily-provider.tsx'
import { DeepLinkProvider } from '@/providers/deep-link-provider.tsx'
import { NoteFindProvider } from '@/providers/note-find-provider.tsx'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider.tsx'
import { ShortcutsProvider } from '@/providers/shortcuts-provider.tsx'
import { SidebarProvider } from '@/providers/sidebar-provider.tsx'

interface WorkspaceProvidersProps {
  graph: GraphInfo
  children: ReactNode
}

/**
 * The per-graph providers of a workspace surface — the ⌘K palette, shortcuts,
 * templates, sidebar state, audio memos, deep links, the focused day and
 * in-note find — under a router the caller mounts: a desktop window mounts
 * its own, the iPad shares the one that outlives its size-class switches.
 */
export function WorkspaceProviders({ graph, children }: WorkspaceProvidersProps): ReactElement {
  return (
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
                  <NoteFindProvider>{children}</NoteFindProvider>
                </FocusedDailyProvider>
              </DeepLinkProvider>
            </AudioMemoProvider>
          </SidebarProvider>
        </NoteTemplatesProvider>
      </ShortcutsProvider>
    </PaletteProvider>
  )
}
