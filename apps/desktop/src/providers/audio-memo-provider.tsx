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
import {
  deriveStore,
  type AudioMemoSession,
  type AudioMemoSessionState,
  type GraphInfo,
  type MobileAudioMemoSessionState,
} from '@reflect/core'
import {
  dismissRecordingReminder,
  showRecordingReminder,
} from '@/components/audio-memo/recording-reminder.ts'
import { useMobileAudioMemo } from '@/mobile/audio-memo-provider.tsx'
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
  /**
   * Where a live recording shows. `popover`: the desktop panel anchored to
   * the mic. `sheet`: the iOS app's recording sheet, which owns the
   * recording UI while the mic only starts and stops it.
   */
  presentation: 'popover' | 'sheet'
}

/**
 * The audio-memo session and its actions.
 */
export const AudioMemoContext = createContext<AudioMemoContextValue | null>(null)

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

/**
 * Why the iOS app's mic is off without a native recorder (a plain browser),
 * in the desktop's words.
 */
const NATIVE_RECORDER_MISSING = 'Audio recording is not supported on this platform'

const CLOSED_SESSION: AudioMemoSessionStores = {
  get: () => CLOSED_STATE,
  subscribe: () => () => {},
  elapsedMs: { get: () => 0, subscribe: () => () => {} },
}

function selectRecorderState(state: AudioMemoSessionState): AudioMemoSessionState['recorderState'] {
  return state.recorderState
}

function selectPhase(state: AudioMemoSessionState): AudioMemoSessionState['phase'] {
  return state.phase
}

function selectAvailable(state: AudioMemoSessionState): AudioMemoSessionState['available'] {
  return state.available
}

function selectUnavailableReason(
  state: AudioMemoSessionState,
): AudioMemoSessionState['unavailableReason'] {
  return state.unavailableReason
}

function selectError(state: AudioMemoSessionState): AudioMemoSessionState['error'] {
  return state.error
}

function selectCanRetry(state: AudioMemoSessionState): AudioMemoSessionState['canRetry'] {
  return state.canRetry
}

function selectStream(state: AudioMemoSessionState): AudioMemoSessionState['stream'] {
  return state.stream
}

/**
 * The desktop's view of the iOS app's recording session.
 */
function toAudioMemoState(state: MobileAudioMemoSessionState): AudioMemoSessionState {
  return {
    phase: state.phase,
    stream: null,
    pendingCount: state.pendingCount,
    // The sheet explains a missing transcription model itself, so the mic
    // opens it rather than going inert; only a missing native recorder (a
    // plain browser) disables it.
    available: state.available,
    unavailableReason: state.available ? null : NATIVE_RECORDER_MISSING,
    error: state.error,
    canRetry: state.canRetry,
    recorderState:
      state.phase === 'recording' || state.phase === 'requesting' ? state.phase : 'idle',
  }
}

interface AudioMemoProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function AudioMemoProvider({ graph, children }: AudioMemoProviderProps): ReactElement {
  const { platform } = useCoreServices()
  // The iOS app records natively, so a capture survives the webview; its
  // session already lives above the workspace (`MobileAudioMemoProvider`),
  // where the lock-screen widget, Siri and the Live Activity reach it. Under
  // the iOS app the desktop workspace borrows that session instead of opening
  // a second recorder.
  if (platform.surface.mobileApp) {
    return <NativeAudioMemoBridge>{children}</NativeAudioMemoBridge>
  }
  return <WebviewAudioMemoProvider graph={graph}>{children}</WebviewAudioMemoProvider>
}

function NativeAudioMemoBridge({ children }: { children: ReactNode }): ReactElement {
  const memo = useMobileAudioMemo()
  const mobileSession = memo.session
  const session = useMemo<AudioMemoSessionStores>(() => {
    const state = deriveStore(mobileSession, toAudioMemoState)
    return { get: state.get, subscribe: state.subscribe, elapsedMs: mobileSession.elapsedMs }
  }, [mobileSession])
  const value = useMemo<AudioMemoContextValue>(
    () => ({
      session,
      toggle: memo.toggle,
      cancel: () => {
        void memo.cancelRecording()
      },
      retry: memo.retry,
      discard: memo.discard,
      presentation: 'sheet',
    }),
    [session, memo],
  )
  return <AudioMemoContext value={value}>{children}</AudioMemoContext>
}

function WebviewAudioMemoProvider({ graph, children }: AudioMemoProviderProps): ReactElement {
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
      presentation: 'popover',
    }),
    [session, store],
  )

  return <AudioMemoContext value={value}>{children}</AudioMemoContext>
}

/**
 * Access the audio-memo session and its actions. Use within an
 * AudioMemoProvider. Reading the context does not subscribe to the state:
 * read fields with the `useAudioMemo*` field hooks, and the elapsed time with
 * `useStore(session.elapsedMs)`.
 */
export function useAudioMemo(): AudioMemoContextValue {
  const context = use(AudioMemoContext)
  if (!context) {
    throw new Error('useAudioMemo must be used within an AudioMemoProvider')
  }
  return context
}

function useAudioMemoSelector<T>(selector: (state: AudioMemoSessionState) => T): T {
  return useSelector(useAudioMemo().session, selector)
}

export function useAudioMemoPhase(): AudioMemoSessionState['phase'] {
  return useAudioMemoSelector(selectPhase)
}

export function useAudioMemoAvailable(): AudioMemoSessionState['available'] {
  return useAudioMemoSelector(selectAvailable)
}

export function useAudioMemoUnavailableReason(): AudioMemoSessionState['unavailableReason'] {
  return useAudioMemoSelector(selectUnavailableReason)
}

export function useAudioMemoError(): AudioMemoSessionState['error'] {
  return useAudioMemoSelector(selectError)
}

export function useAudioMemoCanRetry(): AudioMemoSessionState['canRetry'] {
  return useAudioMemoSelector(selectCanRetry)
}

export function useAudioMemoStream(): AudioMemoSessionState['stream'] {
  return useAudioMemoSelector(selectStream)
}
