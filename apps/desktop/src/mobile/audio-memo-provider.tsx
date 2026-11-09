import {
  createContext,
  use,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import type {
  GraphInfo,
  MobileAudioMemoSession,
  MobileAudioMemoSessionState,
  Store,
} from '@reflect/core'
import { useMobileServices } from '@/mobile/mobile-services.ts'
import { useSelector } from '@/lib/use-store.ts'

/**
 * The mobile React surface for audio memos: a thin shell over the
 * `MobileAudioMemoService` session of the open graph, which owns the native
 * recorder state, the capture queue, the orphan scan, and the native-action
 * handshake. Desktop's provider presents recording in a sidebar popover; here
 * it is a bottom drawer plus the mic action in the Daily capture menu.
 */

/**
 * The session's stores: the state, and the per-tick values apart from it.
 */
export type MobileAudioMemoSessionStores = Pick<
  MobileAudioMemoSession,
  'get' | 'subscribe' | 'elapsedMs' | 'level'
>

interface MobileAudioMemoContextValue extends Pick<
  MobileAudioMemoSession,
  'toggle' | 'stopAndSave' | 'cancelRecording' | 'retry' | 'discard'
> {
  readonly session: MobileAudioMemoSessionStores
  /**
   * Drawer dismissal: a live recording stops-and-saves, never silently drops.
   */
  onDrawerOpenChange: (open: boolean) => void
}

/**
 * The mobile audio-memo session and its actions.
 */
export const MobileAudioMemoContext = createContext<MobileAudioMemoContextValue | null>(null)

/**
 * What the surface shows before the session opens.
 */
const CLOSED_STATE: MobileAudioMemoSessionState = {
  phase: 'idle',
  pendingCount: 0,
  available: false,
  hasTranscriptionConfig: false,
  error: null,
  canRetry: false,
  drawerOpen: false,
}

function selectPhase(state: MobileAudioMemoSessionState): MobileAudioMemoSessionState['phase'] {
  return state.phase
}

function selectAvailable(
  state: MobileAudioMemoSessionState,
): MobileAudioMemoSessionState['available'] {
  return state.available
}

function selectDrawerOpen(
  state: MobileAudioMemoSessionState,
): MobileAudioMemoSessionState['drawerOpen'] {
  return state.drawerOpen
}

function selectError(state: MobileAudioMemoSessionState): MobileAudioMemoSessionState['error'] {
  return state.error
}

function selectCanRetry(
  state: MobileAudioMemoSessionState,
): MobileAudioMemoSessionState['canRetry'] {
  return state.canRetry
}

function selectHasTranscriptionConfig(
  state: MobileAudioMemoSessionState,
): MobileAudioMemoSessionState['hasTranscriptionConfig'] {
  return state.hasTranscriptionConfig
}

const CLOSED_TICK: Store<number> = { get: () => 0, subscribe: () => () => {} }

const CLOSED_SESSION: MobileAudioMemoSessionStores = {
  get: () => CLOSED_STATE,
  subscribe: () => () => {},
  elapsedMs: CLOSED_TICK,
  level: CLOSED_TICK,
}

interface MobileAudioMemoProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function MobileAudioMemoProvider({
  graph,
  children,
}: MobileAudioMemoProviderProps): ReactElement {
  const { mobileAudioMemo } = useMobileServices()

  // Opened before paint, so the mic action never shows the closed state.
  const [session, setSession] = useState<MobileAudioMemoSession | null>(null)
  useLayoutEffect(() => {
    const next = mobileAudioMemo.openSession()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the session is an external resource that this effect opens and disposes
    setSession(next)
    return () => {
      next.dispose()
      setSession((current) => (current === next ? null : current))
    }
  }, [mobileAudioMemo, graph.generation])

  const value = useMemo<MobileAudioMemoContextValue>(
    () => ({
      session: session ?? CLOSED_SESSION,
      toggle: () => session?.toggle(),
      stopAndSave: () => session?.stopAndSave(),
      cancelRecording: () => session?.cancelRecording(),
      onDrawerOpenChange: (open: boolean) => session?.setDrawerOpen(open),
      retry: () => session?.retry(),
      discard: () => session?.discard(),
    }),
    [session],
  )

  return <MobileAudioMemoContext value={value}>{children}</MobileAudioMemoContext>
}

/**
 * Access the mobile audio-memo session and its actions. Use within
 * MobileAudioMemoProvider. Reading the context does not subscribe to the
 * state: read fields with the `useMobileAudioMemo*` field hooks, and the per-tick
 * values with `useStore(session.elapsedMs)` and `useStore(session.level)`.
 */
export function useMobileAudioMemo(): MobileAudioMemoContextValue {
  const context = use(MobileAudioMemoContext)
  if (!context) {
    throw new Error('useMobileAudioMemo must be used within a MobileAudioMemoProvider')
  }
  return context
}

function useMobileAudioMemoSelector<T>(selector: (state: MobileAudioMemoSessionState) => T): T {
  return useSelector(useMobileAudioMemo().session, selector)
}

export function useMobileAudioMemoPhase(): MobileAudioMemoSessionState['phase'] {
  return useMobileAudioMemoSelector(selectPhase)
}

export function useMobileAudioMemoAvailable(): MobileAudioMemoSessionState['available'] {
  return useMobileAudioMemoSelector(selectAvailable)
}

export function useMobileAudioMemoDrawerOpen(): MobileAudioMemoSessionState['drawerOpen'] {
  return useMobileAudioMemoSelector(selectDrawerOpen)
}

export function useMobileAudioMemoError(): MobileAudioMemoSessionState['error'] {
  return useMobileAudioMemoSelector(selectError)
}

export function useMobileAudioMemoCanRetry(): MobileAudioMemoSessionState['canRetry'] {
  return useMobileAudioMemoSelector(selectCanRetry)
}

export function useMobileAudioMemoHasTranscriptionConfig(): MobileAudioMemoSessionState['hasTranscriptionConfig'] {
  return useMobileAudioMemoSelector(selectHasTranscriptionConfig)
}
