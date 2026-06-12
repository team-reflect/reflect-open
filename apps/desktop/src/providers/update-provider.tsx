import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react'
import { hasBridge } from '@reflect/core'
import {
  createUpdateController,
  type UpdateController,
  type UpdateState,
} from '@/lib/update-controller'

interface UpdateContextValue {
  state: UpdateState
  /** False outside the native shell (browser dev) — hide update UI entirely. */
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
  const supported = hasBridge()
  const resolvedAutoCheck = autoCheck ?? (supported && !import.meta.env.DEV)
  const [controller, setController] = useState<UpdateController | null>(null)

  useEffect(() => {
    if (!supported) {
      return
    }
    const next = createUpdateController({ autoCheck: resolvedAutoCheck })
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

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
}

/** Update state + actions; must be used under an {@link UpdateProvider}. */
export function useUpdate(): UpdateContextValue {
  const value = useContext(UpdateContext)
  if (value === null) {
    throw new Error('useUpdate must be used within an UpdateProvider')
  }
  return value
}
