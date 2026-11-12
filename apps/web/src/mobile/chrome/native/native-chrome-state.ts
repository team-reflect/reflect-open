import type { Route } from '@reflect/app'
import type { ThemePreference } from '@reflect/core'
import type { FormattingToolbarCapabilities } from '@/editor/formatting-toolbar-store.ts'
import type { ScreenBar } from '@/mobile/chrome/native/screen-registry.ts'
import { toWireButtons } from '@/mobile/chrome/native/sf-symbols.ts'
import type { MobileTab } from '@/mobile/mobile-tab-bar.tsx'
import { NO_ENTRY, type NativeChromeState } from '@/mobile/native-chrome/protocol.ts'

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
  toolbar: FormattingToolbarCapabilities | null
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
    theme,
  }
}
