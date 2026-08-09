import {
  createContext,
  use,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useMainWindowEffect } from '@/hooks/use-main-window-effect'
import { isNativeShell } from '@/lib/platform'
import {
  createUpdateController,
  type UpdateController,
  type UpdateState,
} from '@/lib/update-controller'

interface UpdateContextValue {
  state: UpdateState
  /**
   * False outside a desktop native shell (browser dev, iOS/Android) — hide
   * update UI entirely. Mobile ships through the app stores, and the updater
   * plugins are only registered under `#[cfg(desktop)]`.
   */
  supported: boolean
  checkNow: () => Promise<void>
  install: () => Promise<void>
  restart: () => Promise<void>
}

const UpdateContext = createContext<UpdateContextValue | null>(null)

const IDLE: UpdateState = { phase: 'idle' }

interface UpdateProviderProps {
  children: ReactNode
  /**
   * Override the launch + periodic check. Defaults to on in the packaged app
   * and off in dev (and wherever no native shell exists) — `tauri dev` builds
   * would otherwise prompt to "update" to the released version.
   */
  autoCheck?: boolean
}

/**
 * Thin React shim over {@link createUpdateController} (Plan 15): one
 * controller for the app's lifetime, surfaced through `useSyncExternalStore`.
 * Mounted above the graph gate so update checks run from first launch, before
 * any graph is open.
 */
export function UpdateProvider({ children, autoCheck }: UpdateProviderProps): ReactElement {
  const supported = isNativeShell()
  const resolvedAutoCheck = autoCheck ?? (supported && !import.meta.env.DEV)
  const [controller, setController] = useState<UpdateController | null>(null)

  // One checker per app: secondary note windows never poll for updates.
  useMainWindowEffect(() => {
    if (!supported) {
      return
    }
    const next = createUpdateController({ autoCheck: resolvedAutoCheck })
    // The controller is an imperative lifecycle object created for the app's
    // lifetime; it must be instantiated in an effect (it subscribes and starts)
    // and stored so useSyncExternalStore can read it.
    setController(next)
    next.start()
    return () => {
      next.dispose()
      setController((current) => (current === next ? null : current))
    }
  }, [supported, resolvedAutoCheck])

  const state = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getState ?? (() => IDLE),
  )

  const value = useMemo<UpdateContextValue>(
    () => ({
      state,
      supported,
      checkNow: () => controller?.checkNow() ?? Promise.resolve(),
      install: () => controller?.install() ?? Promise.resolve(),
      restart: () => controller?.restart() ?? Promise.resolve(),
    }),
    [controller, state, supported],
  )

  return <UpdateContext value={value}>{children}</UpdateContext>
}

/** Update state + actions; must be used under an {@link UpdateProvider}. */
export function useUpdate(): UpdateContextValue {
  const value = use(UpdateContext)
  if (value === null) {
    throw new Error('useUpdate must be used within an UpdateProvider')
  }
  return value
}
