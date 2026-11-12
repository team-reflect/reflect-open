import { createContext, use, useEffect, useLayoutEffect, useRef } from 'react'
import { isDeepEqual } from '@ocavue/utils'
import { WritableStore } from '@reflect/core'
import {
  NO_ENTRY,
  type NativeBarButton,
  type NativeMenuItem,
} from '@/mobile/native-chrome/protocol.ts'
import { useOptionalRouterState } from '@/routing/router.tsx'
import { hasAnyNativeChrome } from '@/services/native-chrome-transport.ts'

/**
 * What one screen shows in the native navigation bar.
 */
export interface NativeBarSpec {
  /** `null` while the title is not known yet (a note before its row loads). */
  title: string | null
  titleMenu?: NativeMenuItem[] | undefined
  leading?: NativeBarButton[] | undefined
  trailing?: NativeBarButton[] | undefined
}

/**
 * The handlers behind one screen's bar. `onBack` replaces the router's back.
 */
export interface NativeBarHandlers {
  onAction: (id: string) => void
  onBack?: (() => void) | undefined
}

/**
 * The bar of every mounted screen, keyed by the history entry the screen
 * shows. A screen kept mounted under a stacked card keeps its own entry, so
 * the shell always gets the bar of the entry on screen.
 */
export const nativeBars = new WritableStore<ReadonlyMap<number, NativeBarSpec>>(
  new Map(),
  isDeepEqual,
)

const barHandlers = new Map<number, { current: NativeBarHandlers }>()

/**
 * Whether the subtree is the screen on top of the mobile stack. Only that
 * screen registers a bar: a hidden layer can mount with the router state of
 * the screen on top, so it would register under the wrong entry.
 */
export const NativeBarLayerContext = createContext(true)

function updateBars(update: (bars: Map<number, NativeBarSpec>) => void): void {
  const next = new Map(nativeBars.get())
  update(next)
  nativeBars.set(next)
}

/**
 * The handlers of the bar of `entryId`.
 */
export function nativeBarHandlers(entryId: number): NativeBarHandlers | undefined {
  return barHandlers.get(entryId)?.current
}

/**
 * Register this screen's bar for the history entry it shows. A no-op when
 * the shell draws no chrome. `spec` may be a new object on every render:
 * only a change of its content reaches the shell.
 */
export function useNativeBar(spec: NativeBarSpec, handlers: NativeBarHandlers): void {
  const entryId = useOptionalRouterState()?.entryId ?? NO_ENTRY
  const enabled = hasAnyNativeChrome() && use(NativeBarLayerContext)
  const handlersRef = useRef(handlers)
  useLayoutEffect(() => {
    handlersRef.current = handlers
  })
  const specJSON = JSON.stringify(spec)

  // Layout effects, so the bar is in the store before the chrome projection
  // posts the state of the new screen from its passive effect.

  useLayoutEffect(() => {
    if (!enabled) {
      return
    }
    barHandlers.set(entryId, handlersRef)
    return () => {
      // Another screen may own the entry by now; its bar stays.
      if (barHandlers.get(entryId) !== handlersRef) {
        return
      }
      barHandlers.delete(entryId)
      updateBars((bars) => {
        bars.delete(entryId)
      })
    }
  }, [enabled, entryId])

  useLayoutEffect(() => {
    if (!enabled) {
      return
    }
    updateBars((bars) => {
      bars.set(entryId, JSON.parse(specJSON) as NativeBarSpec)
    })
  }, [enabled, entryId, specJSON])
}

interface OpenMenu {
  entryId: number
  onSelect: (id: string) => void
}

const openMenus = new Map<string, OpenMenu>()

/**
 * Remember the handler of a menu the page asked the shell to show.
 */
export function rememberNativeMenu(menuId: string, menu: OpenMenu): void {
  openMenus.set(menuId, menu)
}

/**
 * The handler of the menu `menuId`, when it was opened for `entryId`.
 */
export function nativeMenuHandler(menuId: string, entryId: number): ((id: string) => void) | null {
  const menu = openMenus.get(menuId)
  return menu !== undefined && menu.entryId === entryId ? menu.onSelect : null
}

/**
 * How many web drawers are open. The shell hides its bars while one is.
 */
export const nativeModalCount = new WritableStore(0)

/**
 * Count an open web drawer while `open` is true.
 */
export function useNativeModal(open: boolean): void {
  useEffect(() => {
    if (!open || !hasAnyNativeChrome()) {
      return
    }
    nativeModalCount.set(nativeModalCount.get() + 1)
    return () => {
      nativeModalCount.set(nativeModalCount.get() - 1)
    }
  }, [open])
}
