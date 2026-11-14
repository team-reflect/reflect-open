import { useCallback } from 'react'
import { noop } from '@ocavue/utils'
import { notePathForRoute, routeForPath, type Route, type Section } from '@reflect/app'
import { WritableStore } from '@reflect/core'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { useNoteLabel } from '@/hooks/use-note-label.ts'
import { useGraphColors } from '@/hooks/use-graph-colors.ts'
import { useStore } from '@/lib/use-store.ts'
import { graphColorCss } from '@/lib/graph-colors.ts'
import { useToday } from '@/lib/use-today.ts'
import type { ChromeMenuItem } from '@/mobile/chrome/screen-chrome.ts'
import { shareNote } from '@/mobile/share.ts'
import { useGraphInfo } from '@/providers/graph-provider.tsx'
import { useRouterActions, useRouterState } from '@/routing/router.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

/**
 * Whether the iPad sidebar shows, or `null` without a sidebar (iPhone, a
 * compact iPad window, the web). The Swift shell reports it.
 */
export const sidebarVisible = new WritableStore<boolean | null>(null)

/**
 * Keeps the section Chat navigations join in step with the layout: Chat is
 * its own section on iPad with a sidebar (shown or hidden), where it is a
 * top-level tab, and a card over All elsewhere.
 */
export function useSyncChatSection(): void {
  const { navigation } = useAppServices()
  const hasSidebar = useStore(sidebarVisible) !== null
  // Set while rendering, before any screen can navigate.
  navigation.setChatSection(hasSidebar ? 'chat' : 'all')
}

/**
 * A tap in the iPad sidebar.
 */
export type SidebarCommand =
  | { kind: 'chat' | 'search' | 'settings' }
  | { kind: 'openNote' | 'unpin' | 'share'; path: string }
  | { kind: 'menu'; id: string }

/**
 * What the iPad sidebar shows. `selection` is a tab, `chat`, or a pinned
 * note's path after `pinned:`; `graphColor` is `#rrggbb`, or `null` for the
 * app's tint.
 */
export interface SidebarState {
  selection: string
  pinned: { path: string; title: string }[]
  graphName: string
  graphColor: string | null
  graphMenu: ChromeMenuItem[]
}

/**
 * The sidebar row of `route`: the pinned note on screen, Chat, or else the
 * row of the entry's section.
 */
export function selectSidebarRow(
  route: Route,
  section: Section,
  pinnedPaths: ReadonlySet<string>,
  today: string,
): string {
  const path = notePathForRoute(route, today)
  if (path !== null && pinnedPaths.has(path)) {
    return `pinned:${path}`
  }
  return route.kind === 'chat' ? 'chat' : section
}

/**
 * The graph menu of the sidebar's graph button and of the iPad top bar.
 */
export function useGraphMenu(): {
  title: string
  items: ChromeMenuItem[]
  run: (id: string) => void
} {
  const graph = useGraphInfo()
  const { navigate } = useRouterActions()
  const { opener } = useAppServices()
  const title = graph?.name ?? 'Graph'
  const items: ChromeMenuItem[] = [
    { type: 'action', id: 'graph', title, checked: true, disabled: true },
    { type: 'action', id: 'graphs', title: 'Switch graph…' },
    {
      type: 'section',
      items: [
        { type: 'action', id: 'settings', title: 'Settings', icon: 'settings' },
        { type: 'action', id: 'academy', title: 'Reflect Academy' },
      ],
    },
  ]
  const run = useCallback(
    (id: string): void => {
      if (id === 'graphs') {
        navigate({ kind: 'settings', page: 'graphs' })
      } else if (id === 'settings') {
        navigate({ kind: 'settings', page: 'main' })
      } else if (id === 'academy') {
        opener.openUrlSync('https://reflect.academy')
      }
    },
    [navigate, opener],
  )
  return { title, items, run }
}

/**
 * What the iPad sidebar shows for `tab`, and the runner of its taps.
 */
export function useSidebar(): {
  state: SidebarState
  run: (command: SidebarCommand) => void
} {
  const { route, section } = useRouterState()
  const { navigate, selectSection } = useRouterActions()
  const { noteActions, logger } = useCoreServices()
  const { share } = useAppServices()
  const today = useToday()
  const pinned = usePinnedNotes()
  const noteLabel = useNoteLabel()
  const graph = useGraphInfo()
  const { colorFor } = useGraphColors()
  const graphMenu = useGraphMenu()
  const color = graph === null ? undefined : graphColorCss(colorFor(graph.root))

  const state: SidebarState = {
    selection: selectSidebarRow(route, section, new Set(pinned.map((note) => note.path)), today),
    pinned: pinned.map((note) => ({ path: note.path, title: noteLabel(note) })),
    graphName: graphMenu.title,
    graphColor: color?.startsWith('#') === true ? color : null,
    graphMenu: graphMenu.items,
  }

  const run = (command: SidebarCommand): void => {
    switch (command.kind) {
      case 'chat':
        // Chat returns to where it was left where it is a section, and opens
        // as a card over All elsewhere.
        if (sidebarVisible.get() === null) {
          navigate({ kind: 'chat' })
        } else {
          selectSection('chat')
        }
        return
      case 'search':
        // All lands with its search field focused.
        navigate({ kind: 'allNotes', tag: null }, { focusEditor: true })
        return
      case 'settings':
        navigate({ kind: 'settings', page: 'main' })
        return
      case 'openNote':
        navigate(routeForPath(command.path))
        return
      case 'unpin':
        noteActions.unpin(command.path).catch(noop)
        return
      case 'share':
        shareNote(share, command.path).catch((cause: unknown) => {
          logger.error('share failed:', cause)
        })
        return
      case 'menu':
        graphMenu.run(command.id)
        return
    }
  }

  return { state, run }
}
