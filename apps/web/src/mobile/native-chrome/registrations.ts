import { createContext, use, useEffect, useLayoutEffect, useRef } from 'react'
import { isDeepEqual } from '@ocavue/utils'
import { WritableStore } from '@reflect/core'
import type { NativeBarButton } from '@/mobile/native-chrome/protocol.ts'
import { useRouterState } from '@/routing/router.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * The native corner buttons of one screen. The screen draws its own title.
 */
export interface NativeBarSpec {
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
  const { entryId } = useRouterState()
  const enabled = useAppServices().nativeChrome.enabled && use(NativeBarLayerContext)
  const handlersRef = useRef(handlers)
  useLayoutEffect(() => {
    handlersRef.current = handlers
  })
  const specRef = useRef(spec)
  useLayoutEffect(() => {
    specRef.current = spec
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
    // Another screen may own the entry by now; its bar stays.
    if (!enabled || barHandlers.get(entryId) !== handlersRef) {
      return
    }
    // A snapshot, so an in-place change of the caller's spec is a change.
    updateBars((bars) => {
      bars.set(entryId, structuredClone(specRef.current))
    })
  }, [enabled, entryId, specJSON])
}

/**
 * How many web drawers are open. The shell hides its bars while one is.
 */
export const nativeModalCount = new WritableStore(0)

/**
 * Count an open web drawer while `open` is true.
 */
export function useNativeModal(open: boolean): void {
  const enabled = useAppServices().nativeChrome.enabled
  useEffect(() => {
    if (!open || !enabled) {
      return
    }
    nativeModalCount.set(nativeModalCount.get() + 1)
    return () => {
      nativeModalCount.set(nativeModalCount.get() - 1)
    }
  }, [open, enabled])
}
