import type { ToolbarState } from '@reflect/types'
import { formatMonthLabel, type Route } from '@reflect/app'
import type { ThemePreference } from '@reflect/core'
import { toWireButtons } from '@/mobile/chrome/native/sf-symbols.ts'
import type { MobileTab } from '@/mobile/mobile-tab-bar.tsx'
import {
  NO_ENTRY,
  type NativeChromeState,
  type NativeChromeTitle,
  type NativePlusState,
  type NativeSearchState,
  type NativeSidebarState,
} from '@/mobile/chrome/native/protocol.ts'
import type { ChromeButton, ChromePlus, ChromeTitle } from '@/mobile/chrome/screen-chrome.ts'

/**
 * The top bar of one screen without its handlers.
 */
export interface ScreenBar {
  canBack: boolean
  hidesTabBar: boolean
  leading: ChromeButton[]
  trailing: ChromeButton[]
  plus: NativePlusState | null
  title: NativeChromeTitle | null
  search: NativeSearchState | null
}

/**
 * The title without its handler. A month title shows the label of its month
 * and starts the picker at the selected month.
 */
export function toWireTitle(title: ChromeTitle): NativeChromeTitle {
  return typeof title === 'string'
    ? { kind: 'text', text: title }
    : { kind: 'month', text: formatMonthLabel(title.month), month: title.selected }
}

/**
 * The `+` without its handlers.
 */
export function toWirePlus(plus: ChromePlus): NativePlusState {
  return plus.kind === 'capture'
    ? { kind: 'capture', audio: plus.audio }
    : { kind: 'action', label: plus.label }
}

/**
 * A chrome state before the transport numbers it.
 */
export type UnnumberedChromeState = Omit<NativeChromeState, 'generation'>

export interface ShellChromeInput {
  route: Route
  entryId: number
  tab: MobileTab
  bar: ScreenBar | undefined
  keyboardVisible: boolean
  modal: boolean
  toolbar: ToolbarState | null
  sidebar: NativeSidebarState | null
  history: NativeChromeState['history']
  fullscreen: boolean
  theme: ThemePreference
}

/**
 * The chrome state of the routed shell.
 */
export function buildShellChromeState(input: ShellChromeInput): UnnumberedChromeState {
  const { route, bar } = input
  return {
    type: 'state',
    entryId: input.entryId,
    chrome: 'shell',
    routeKind: route.kind,
    tab: input.tab,
    canBack: bar?.canBack ?? false,
    leading: toWireButtons(bar?.leading ?? []),
    trailing: toWireButtons(bar?.trailing ?? []),
    keyboardVisible: input.keyboardVisible,
    modal: input.modal,
    toolbar: input.toolbar === null ? null : { ...input.toolbar },
    plus: bar?.plus ?? null,
    sidebar: input.sidebar,
    history: input.history,
    title: bar?.title ?? null,
    search: bar?.search ?? null,
    fullscreen: input.fullscreen,
    hidesTabBar: bar?.hidesTabBar ?? false,
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
    leading: [],
    trailing: [],
    keyboardVisible: false,
    modal: false,
    toolbar: null,
    plus: null,
    sidebar: null,
    history: null,
    title: null,
    search: null,
    fullscreen: false,
    hidesTabBar: false,
    theme,
  }
}
