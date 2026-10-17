import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import type {
  AudioMemoPhase,
  AudioMemoSession,
  AudioMemoSessionState,
  GraphInfo,
} from '@reflect/core'
import {
  dismissRecordingReminder,
  showRecordingReminder,
} from '@/components/audio-memo/recording-reminder.ts'
import { useSidebar } from '@/providers/sidebar-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

/**
 * The desktop React surface for audio memos: a thin shell over the
 * `AudioMemoService` session of the open graph, which owns the recorder state,
 * the capture queue, and the transcription lifecycle. The session is opened
 * here — above the sidebar — because the mic button unmounts with the sidebar
 * (`Mod-\`); the shell tells the session when the sidebar collapses, and the
 * session stops and saves instead of leaving a hidden hot microphone.
 */

export type { AudioMemoPhase }

export type AudioMemoContextValue = AudioMemoSessionState &
  Pick<AudioMemoSession, 'cancel' | 'retry' | 'discard'> & {
    /**
     * Idle → start recording (expanding a collapsed sidebar); recording → stop & save.
     */
    toggle: () => void
  }

const AudioMemoContext = createContext<AudioMemoContextValue | null>(null)

/**
 * What the surface shows before the session opens.
 */
const CLOSED_STATE: AudioMemoSessionState = {
  phase: 'idle',
  elapsedMs: 0,
  stream: null,
  pendingCount: 0,
  available: false,
  unavailableReason: null,
  error: null,
  canRetry: false,
  recorderState: 'idle',
}

const CLOSED_SESSION = {
  subscribe: () => () => {},
  getState: () => CLOSED_STATE,
}

interface AudioMemoProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function AudioMemoProvider({ graph, children }: AudioMemoProviderProps): ReactElement {
  const { audioMemo } = useCoreServices()
  const { collapsed, toggleSidebar } = useSidebar()

  // Read at call time: the session outlives the renders that made these.
  const collapsedRef = useRef(collapsed)
  const toggleSidebarRef = useRef(toggleSidebar)
  useEffect(() => {
    collapsedRef.current = collapsed
    toggleSidebarRef.current = toggleSidebar
  })

  // Opened before paint, so the mic never shows the closed state.
  const [session, setSession] = useState<AudioMemoSession | null>(null)
  useLayoutEffect(() => {
    const next = audioMemo.openSession({
      surfaceHidden: collapsedRef.current,
      surface: {
        reveal: () => {
          toggleSidebarRef.current()
        },
        showReminder: showRecordingReminder,
        dismissReminder: dismissRecordingReminder,
      },
    })
    setSession(next)
    return () => {
      next.dispose()
      setSession((current) => (current === next ? null : current))
    }
  }, [audioMemo, graph.generation])

  const store = session ?? CLOSED_SESSION
  const state = useServiceState(store, store.getState)

  // The mic button (and its popover) unmount with the sidebar. The session
  // decides what a hidden surface means for a live recording or a pending
  // permission request; it needs the answer again after each recorder change.
  const recorderState = state.recorderState
  useEffect(() => {
    session?.setSurfaceHidden(collapsed)
  }, [session, collapsed, recorderState])

  const controls = useMemo(
    () => ({
      toggle: () => session?.toggle(),
      cancel: () => session?.cancel(),
      retry: () => session?.retry(),
      discard: () => session?.discard(),
    }),
    [session],
  )
  const value = useMemo<AudioMemoContextValue>(() => ({ ...state, ...controls }), [state, controls])

  return <AudioMemoContext value={value}>{children}</AudioMemoContext>
}

/**
 * Access the audio-memo surface. Use within an AudioMemoProvider.
 */
export function useAudioMemo(): AudioMemoContextValue {
  const context = use(AudioMemoContext)
  if (!context) {
    throw new Error('useAudioMemo must be used within an AudioMemoProvider')
  }
  return context
}
