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
import { useStore } from '@/lib/use-store.ts'

/**
 * The mobile React surface for audio memos: a thin shell over the
 * `MobileAudioMemoService` session of the open graph, which owns the native
 * recorder state, the capture queue, the orphan scan, and the native-action
 * handshake. Desktop's provider presents recording in a sidebar popover; here
 * it is a bottom drawer plus the mic action in the Daily capture menu.
 */

export type MobileAudioMemoContextValue = MobileAudioMemoSessionState &
  Pick<
    MobileAudioMemoSession,
    'toggle' | 'stopAndSave' | 'cancelRecording' | 'retry' | 'discard'
  > & {
    /**
     * Live while recording.
     */
    elapsedMs: number
    /**
     * Latest input level 0…1, for the waveform.
     */
    level: number
    /**
     * Drawer dismissal: a live recording stops-and-saves, never silently drops.
     */
    onDrawerOpenChange: (open: boolean) => void
  }

const MobileAudioMemoContext = createContext<MobileAudioMemoContextValue | null>(null)

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

const CLOSED_TICK: Store<number> = { get: () => 0, subscribe: () => () => {} }

const CLOSED_SESSION: Pick<MobileAudioMemoSession, 'get' | 'subscribe' | 'elapsedMs' | 'level'> = {
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

  const store = session ?? CLOSED_SESSION
  const state = useStore(store)
  const elapsedMs = useStore(store.elapsedMs)
  const level = useStore(store.level)

  const controls = useMemo(
    () => ({
      toggle: () => session?.toggle(),
      stopAndSave: () => session?.stopAndSave(),
      cancelRecording: () => session?.cancelRecording(),
      onDrawerOpenChange: (open: boolean) => session?.setDrawerOpen(open),
      retry: () => session?.retry(),
      discard: () => session?.discard(),
    }),
    [session],
  )
  const value = useMemo<MobileAudioMemoContextValue>(
    () => ({ ...state, elapsedMs, level, ...controls }),
    [state, elapsedMs, level, controls],
  )

  return <MobileAudioMemoContext value={value}>{children}</MobileAudioMemoContext>
}

/**
 * Access the mobile audio-memo surface. Use within MobileAudioMemoProvider.
 */
export function useMobileAudioMemo(): MobileAudioMemoContextValue {
  const context = use(MobileAudioMemoContext)
  if (!context) {
    throw new Error('useMobileAudioMemo must be used within a MobileAudioMemoProvider')
  }
  return context
}
