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
import type { MobileTab } from '@/mobile/mobile-tab-bar.tsx'
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
 * The section a Chat navigation lands in: its own on iPad with a sidebar
 * (shown or hidden), where Chat is a top-level tab; All elsewhere, where
 * Chat is a card over All.
 */
export function chatSection(): Section {
  return sidebarVisible.get() === null ? 'all' : 'chat'
}

/**
 * Whether a Chat screen on screen is the root of the Chat section, with
 * nothing below it: the entry is in the Chat section and the layout has one.
 */
export function useChatIsRoot(): boolean {
  const { section } = useRouterState()
  const hasChatSection = useStore(sidebarVisible) !== null
  return section === 'chat' && hasChatSection
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
 * row under the screen (a tab, or `chat` for the Chat section).
 */
export function selectSidebarRow(
  route: Route,
  tab: MobileTab | 'chat',
  pinnedPaths: ReadonlySet<string>,
  today: string,
): string {
  const path = notePathForRoute(route, today)
  if (path !== null && pinnedPaths.has(path)) {
    return `pinned:${path}`
  }
  return route.kind === 'chat' ? 'chat' : tab
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
        navigate({ kind: 'graphs' })
      } else if (id === 'settings') {
        navigate({ kind: 'settings' })
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
export function useSidebar(tab: MobileTab): {
  state: SidebarState
  run: (command: SidebarCommand) => void
} {
  const { route, section } = useRouterState()
  const { navigate } = useRouterActions()
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
    selection: selectSidebarRow(
      route,
      section === 'chat' ? 'chat' : tab,
      new Set(pinned.map((note) => note.path)),
      today,
    ),
    pinned: pinned.map((note) => ({ path: note.path, title: noteLabel(note) })),
    graphName: graphMenu.title,
    graphColor: color?.startsWith('#') === true ? color : null,
    graphMenu: graphMenu.items,
  }

  const run = (command: SidebarCommand): void => {
    switch (command.kind) {
      case 'chat':
        navigate({ kind: 'chat' }, { section: chatSection() })
        return
      case 'search':
        // All lands with its search field focused.
        navigate({ kind: 'allNotes', tag: null }, { focusEditor: true })
        return
      case 'settings':
        navigate({ kind: 'settings' })
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
