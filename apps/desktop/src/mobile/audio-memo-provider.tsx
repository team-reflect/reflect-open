import {
  createContext,
  use,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { GraphInfo, MobileAudioMemoSession, MobileAudioMemoSessionState } from '@reflect/core'
import { useMobileServices } from '@/mobile/mobile-services.ts'
import { useServiceState } from '@/services/use-service-state.ts'

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
  elapsedMs: 0,
  level: 0,
  pendingCount: 0,
  available: false,
  hasTranscriptionConfig: false,
  error: null,
  canRetry: false,
  drawerOpen: false,
}

const CLOSED_SESSION = {
  subscribe: () => () => {},
  getState: () => CLOSED_STATE,
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
  const state = useServiceState(store, store.getState)

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
    () => ({ ...state, ...controls }),
    [state, controls],
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
