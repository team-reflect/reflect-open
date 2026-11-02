import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { AudioMemoSession, AudioMemoSessionState, GraphInfo } from '@reflect/core'
import {
  dismissRecordingReminder,
  showRecordingReminder,
} from '@/components/audio-memo/recording-reminder.ts'
import { useSidebar } from '@/providers/sidebar-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useSelector } from '@/lib/use-store.ts'

/**
 * The desktop React surface for audio memos: a thin shell over the
 * `AudioMemoService` session of the open graph, which owns the recorder state,
 * the capture queue, and the transcription lifecycle. The session is opened
 * here — above the sidebar — because the mic button unmounts with the sidebar
 * (`Mod-\`); the shell tells the session when the sidebar collapses, and the
 * session stops and saves instead of leaving a hidden hot microphone.
 */

/**
 * The session's stores: the state, and the elapsed time apart from it.
 */
export type AudioMemoSessionStores = Pick<AudioMemoSession, 'get' | 'subscribe' | 'elapsedMs'>

export interface AudioMemoContextValue extends Pick<
  AudioMemoSession,
  'cancel' | 'retry' | 'discard'
> {
  readonly session: AudioMemoSessionStores
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
  stream: null,
  pendingCount: 0,
  available: false,
  unavailableReason: null,
  error: null,
  canRetry: false,
  recorderState: 'idle',
}

const CLOSED_SESSION: AudioMemoSessionStores = {
  get: () => CLOSED_STATE,
  subscribe: () => () => {},
  elapsedMs: { get: () => 0, subscribe: () => () => {} },
}

function selectRecorderState(state: AudioMemoSessionState): AudioMemoSessionState['recorderState'] {
  return state.recorderState
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

  // The mic button (and its popover) unmount with the sidebar. The session
  // decides what a hidden surface means for a live recording or a pending
  // permission request; it needs the answer again after each recorder change.
  const recorderState = useSelector(store, selectRecorderState)
  useEffect(() => {
    session?.setSurfaceHidden(collapsed)
  }, [session, collapsed, recorderState])

  const value = useMemo<AudioMemoContextValue>(
    () => ({
      session: store,
      toggle: () => session?.toggle(),
      cancel: () => session?.cancel(),
      retry: () => session?.retry(),
      discard: () => session?.discard(),
    }),
    [session, store],
  )

  return <AudioMemoContext value={value}>{children}</AudioMemoContext>
}

/**
 * Access the audio-memo session and its actions. Use within an
 * AudioMemoProvider. Reading the context does not subscribe to the state:
 * read fields with {@link useAudioMemoField}, and the elapsed time with
 * `useStore(session.elapsedMs)`.
 */
export function useAudioMemo(): AudioMemoContextValue {
  const context = use(AudioMemoContext)
  if (!context) {
    throw new Error('useAudioMemo must be used within an AudioMemoProvider')
  }
  return context
}

/**
 * One field of the audio-memo state, re-rendered only when that field changes.
 */
export function useAudioMemoField<K extends keyof AudioMemoSessionState>(
  key: K,
): AudioMemoSessionState[K] {
  const selector = useCallback((state: AudioMemoSessionState) => state[key], [key])
  return useSelector(useAudioMemo().session, selector)
}
