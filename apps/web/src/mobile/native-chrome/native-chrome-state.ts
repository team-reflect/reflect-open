import type { Route } from '@reflect/app'
import type { ThemePreference } from '@reflect/core'
import type { FormattingToolbarCapabilities } from '@/editor/formatting-toolbar-store.ts'
import { tabRootFor, type MobileTab } from '@/mobile/mobile-tab-bar.tsx'
import { NO_ENTRY, type NativeChromeState } from '@/mobile/native-chrome/protocol.ts'
import type { NativeBarSpec } from '@/mobile/native-chrome/registrations.ts'
import { postNativeChrome } from '@/services/native-chrome-transport.ts'

/**
 * A chrome state before the transport numbers it.
 */
export type UnnumberedChromeState = Omit<NativeChromeState, 'generation'>

/**
 * The title of a route whose screen registers no bar.
 */
function defaultTitle(route: Route): string | null {
  switch (route.kind) {
    case 'today':
    case 'daily':
      return ''
    case 'allNotes':
    case 'search':
      return 'All notes'
    case 'tasks':
      return 'Tasks'
    case 'chat':
      return 'Chat'
    case 'settings':
      return 'Settings'
    case 'graphs':
      return 'Graphs'
    case 'licenses':
      return 'Licenses'
    case 'note':
      return null
  }
}

export interface ShellChromeInput {
  route: Route
  entryId: number
  tab: MobileTab
  bar: NativeBarSpec | undefined
  keyboardVisible: boolean
  modal: boolean
  toolbar: FormattingToolbarCapabilities | null
  theme: ThemePreference
}

/**
 * The chrome state of the routed shell. All and Tasks keep their web search
 * header, so they ask for no navigation bar.
 */
export function buildShellChromeState(input: ShellChromeInput): UnnumberedChromeState {
  const { route, bar } = input
  return {
    type: 'state',
    entryId: input.entryId,
    chrome: 'shell',
    routeKind: route.kind,
    tab: input.tab,
    canBack: tabRootFor(route) === null,
    title: bar === undefined ? defaultTitle(route) : bar.title,
    titleMenu: bar?.titleMenu ?? null,
    showsBar: route.kind !== 'allNotes' && route.kind !== 'search' && route.kind !== 'tasks',
    leading: bar?.leading ?? [],
    trailing: bar?.trailing ?? [],
    keyboardVisible: input.keyboardVisible,
    modal: input.modal,
    toolbar: input.toolbar === null ? null : { ...input.toolbar },
    theme: input.theme,
  }
}

/**
 * The chrome state of a surface outside the shell (onboarding, loading,
 * error): no native bars.
 */
export function buildNoChromeState(theme: ThemePreference): UnnumberedChromeState {
  return {
    type: 'state',
    entryId: NO_ENTRY,
    chrome: 'none',
    routeKind: null,
    tab: 'daily',
    canBack: false,
    title: null,
    titleMenu: null,
    showsBar: false,
    leading: [],
    trailing: [],
    keyboardVisible: false,
    modal: false,
    toolbar: null,
    theme,
  }
}

let generation = 0
let lastStateJSON = ''

/**
 * Post `state` when it differs from the last one, numbered with the next
 * generation of this document.
 */
export function postChromeState(state: UnnumberedChromeState): void {
  const json = JSON.stringify(state)
  if (json === lastStateJSON) {
    return
  }
  lastStateJSON = json
  generation += 1
  postNativeChrome({ ...state, generation })
}
