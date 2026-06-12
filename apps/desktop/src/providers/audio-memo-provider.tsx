import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  errorMessage,
  pickTranscriptionConfig,
  saveAudioMemo,
  type AudioMemoResume,
  type GraphInfo,
  type SaveAudioMemoOutcome,
} from '@reflect/core'
import { isRecordingSupported, useAudioRecorder } from '@/hooks/use-audio-recorder'
import { todayIso } from '@/lib/dates'
import { startOperation } from '@/lib/operations'
import { providerFetch } from '@/lib/provider-fetch'
import { useSettings } from '@/providers/settings-provider'
import { useSidebar } from '@/providers/sidebar-provider'

/**
 * The React surface for audio memos: recording state + the bridge to the
 * core capture action (`saveAudioMemo`, which owns transcription, privacy,
 * and the daily-note append). State lives here — above the sidebar — because
 * the mic button unmounts with the sidebar (`Mod-\`), and a recording must
 * never outlive its UI invisibly: collapsing mid-recording stops and saves
 * instead of leaving a hidden hot microphone.
 *
 * Saves drain through a serial queue so memos can be recorded back-to-back
 * while earlier ones are still transcribing. One save at a time keeps the
 * daily-note read-modify-write race-free and appends memos in recording
 * order; a resumable failure parks the queue behind the error, so a retry
 * lands its transcript before the memos recorded after it.
 */

/**
 * 'transcribing' means committed memos are still saving in the background —
 * the mic stays available, so the next recording can start immediately.
 */
export type AudioMemoPhase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error'

interface AudioMemoContextValue {
  phase: AudioMemoPhase
  /** Live while recording. */
  elapsedMs: number
  /** The live input stream, for the waveform. */
  stream: MediaStream | null
  /** Memos committed but not yet appended — queued plus in flight. */
  pendingCount: number
  /** False when no OpenAI/Gemini model is configured or the platform can't record. */
  available: boolean
  /** Why the mic is disabled (tooltip copy), null when `available`. */
  unavailableReason: string | null
  /** The failure shown in the error phase. */
  error: string | null
  /** True when a retry can pick up where the failure left off. */
  canRetry: boolean
  /** Idle → start recording (expanding a collapsed sidebar); recording → stop & save. */
  toggle: () => void
  /** Discard the in-flight recording without transcribing. */
  cancel: () => void
  /** Re-run the failed step — transcription is never paid for twice. */
  retry: () => void
  /** Drop the failed memo and let the queue continue. */
  discard: () => void
}

const AudioMemoContext = createContext<AudioMemoContextValue | null>(null)

/** Auto-stop cap: bounds the transcription payload (Gemini inlines base64). */
const MAX_DURATION_MS = 10 * 60_000

const NO_PROVIDER_REASON = 'Add an OpenAI or Gemini model in Settings to record audio memos'
const UNSUPPORTED_REASON = 'Audio recording is not supported on this platform'

/** Same macOS check as `hasMacosTitleBarOverlay` — settings paths differ per OS. */
function micDeniedMessage(): string {
  const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')
  return isMac
    ? 'Microphone access was denied. Allow it in System Settings → Privacy & Security → Microphone.'
    : 'Microphone access was denied. Allow microphone access for Reflect in your system settings.'
}

interface AudioMemoProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function AudioMemoProvider({ graph, children }: AudioMemoProviderProps): ReactElement {
  const { settings } = useSettings()
  const { collapsed, toggleSidebar } = useSidebar()

  const [pendingCount, setPendingCount] = useState(0)
  /** True from the stop click until the recorder hands over the blob. */
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resume, setResume] = useState<AudioMemoResume | null>(null)

  const stopAndSaveRef = useRef<() => void>(() => {})
  const recorder = useAudioRecorder({
    maxDurationMs: MAX_DURATION_MS,
    onMaxDuration: () => stopAndSaveRef.current(),
  })
  // The hook's functions are stable; the wrapper object is not (elapsed ticks
  // remint it every render). Callbacks and effects must hang off the
  // functions, or the collapse effect re-fires on every recording tick.
  const startRecorder = recorder.start
  const stopRecorder = recorder.stop
  const cancelRecorder = recorder.cancel

  const supported = isRecordingSupported()
  const transcriptionConfig = useMemo(
    () =>
      pickTranscriptionConfig({
        models: settings.aiModels,
        defaultModelId: settings.defaultAiModelId,
      }),
    [settings.aiModels, settings.defaultAiModelId],
  )

  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed

  /** Committed memos waiting their turn; the pump owns the head. */
  const queueRef = useRef<AudioMemoResume[]>([])
  /** Single-drainer guard: one pump loop at a time, one append at a time. */
  const pumpingRef = useRef(false)
  /**
   * The failed step a retry should re-run. While parked, the queue holds —
   * memo order in the note must survive the failure. A ref, not state: rapid
   * double Retry must see the first click's take synchronously, or two
   * pipelines append the transcript twice.
   */
  const parkedRef = useRef<AudioMemoResume | null>(null)
  /** Re-entry guard for the stop click's await gap. */
  const stoppingRef = useRef(false)

  const pump = useCallback(async (): Promise<void> => {
    if (pumpingRef.current) {
      return
    }
    pumpingRef.current = true
    try {
      while (parkedRef.current === null) {
        const payload = queueRef.current.shift()
        if (payload === undefined) {
          break
        }
        let outcome: SaveAudioMemoOutcome
        try {
          outcome = await saveAudioMemo({
            payload,
            models: { models: settings.aiModels, defaultModelId: settings.defaultAiModelId },
            date: todayIso(),
            generation: graph.generation,
            fetchFn: providerFetch,
          })
        } finally {
          setPendingCount((count) => count - 1)
        }
        if (!outcome.ok) {
          // Resumable: park the queue behind the failure. Non-resumable
          // (nothing to re-run, nothing to mis-order): surface and keep
          // draining the memos behind it.
          parkedRef.current = outcome.resume
          setResume(outcome.resume)
          setError(outcome.message)
          if (collapsedRef.current) {
            // The mic button (and its popover) unmounted with the sidebar —
            // the failure must still surface somewhere.
            startOperation('Saving audio memo').fail(outcome.message)
          }
        }
      }
    } finally {
      pumpingRef.current = false
    }
  }, [settings.aiModels, settings.defaultAiModelId, graph.generation])

  const start = useCallback(async (): Promise<void> => {
    if (!supported || transcriptionConfig === null) {
      return
    }
    if (collapsedRef.current) {
      // Never record without visible recording UI.
      toggleSidebar()
    }
    try {
      await startRecorder()
    } catch (cause) {
      setError(
        cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? micDeniedMessage()
          : errorMessage(cause),
      )
    }
  }, [supported, transcriptionConfig, toggleSidebar, startRecorder])

  const stopAndSave = useCallback(async (): Promise<void> => {
    if (stoppingRef.current) {
      return
    }
    stoppingRef.current = true
    // The stop click commits the memo: flip to 'transcribing' before the stop
    // settles, so an Esc landing in the await gap can't read a lingering
    // 'recording' phase and cancel a recording the user just saved.
    setStopping(true)
    try {
      const recording = await stopRecorder()
      if (recording !== null) {
        queueRef.current.push({
          kind: 'transcribe',
          audio: recording.blob,
          mimeType: recording.mimeType,
        })
        setPendingCount((count) => count + 1)
        void pump()
      }
    } finally {
      stoppingRef.current = false
      setStopping(false)
    }
  }, [stopRecorder, pump])
  stopAndSaveRef.current = () => void stopAndSave()

  const discard = useCallback((): void => {
    parkedRef.current = null
    setError(null)
    setResume(null)
    void pump()
  }, [pump])

  const toggle = useCallback((): void => {
    if (recorder.status === 'recording') {
      void stopAndSave()
    } else if (recorder.status === 'requesting') {
      // A second press while the OS prompt is up aborts the request — the
      // alternative is a click that visibly does nothing.
      cancelRecorder()
    } else if (error !== null) {
      // A parked error must never invisibly block recording. Collapsed, the
      // error UI doesn't exist — surface it; visible, it was on screen and a
      // fresh record request acknowledges it (the same click the red mic
      // anchor handles).
      if (collapsedRef.current) {
        toggleSidebar()
      } else {
        discard()
      }
    } else if (recorder.status === 'idle') {
      void start()
    }
  }, [recorder.status, error, stopAndSave, cancelRecorder, start, toggleSidebar, discard])

  const cancel = useCallback((): void => {
    cancelRecorder()
  }, [cancelRecorder])

  const retry = useCallback((): void => {
    const parked = parkedRef.current
    if (parked === null) {
      return
    }
    parkedRef.current = null
    setError(null)
    setResume(null)
    queueRef.current.unshift(parked)
    setPendingCount((count) => count + 1)
    void pump()
  }, [pump])

  // Collapsing the sidebar mid-flow: stop-and-save a live recording, and
  // abandon a pending permission request — a grant arriving after the
  // collapse would otherwise start a recording with no UI mounted.
  useEffect(() => {
    if (!collapsed) {
      return
    }
    if (recorder.status === 'recording') {
      void stopAndSave()
    } else if (recorder.status === 'requesting') {
      cancelRecorder()
    }
  }, [collapsed, recorder.status, cancelRecorder, stopAndSave])

  // A live capture owns the surface — a background save's failure parks and
  // shows after the stop, never yanking the waveform mid-recording.
  const phase: AudioMemoPhase =
    recorder.status === 'recording' && !stopping
      ? 'recording'
      : recorder.status === 'requesting'
        ? 'requesting'
        : error !== null
          ? 'error'
          : stopping || pendingCount > 0
            ? 'transcribing'
            : 'idle'

  const unavailableReason = !supported
    ? UNSUPPORTED_REASON
    : transcriptionConfig === null
      ? NO_PROVIDER_REASON
      : null

  const value = useMemo<AudioMemoContextValue>(
    () => ({
      phase,
      elapsedMs: recorder.elapsedMs,
      stream: recorder.stream,
      pendingCount,
      available: unavailableReason === null,
      unavailableReason,
      error,
      canRetry: resume !== null,
      toggle,
      cancel,
      retry,
      discard,
    }),
    [
      phase,
      recorder.elapsedMs,
      recorder.stream,
      pendingCount,
      unavailableReason,
      error,
      resume,
      toggle,
      cancel,
      retry,
      discard,
    ],
  )

  return <AudioMemoContext.Provider value={value}>{children}</AudioMemoContext.Provider>
}

/** Access the audio-memo surface. Use within an AudioMemoProvider. */
export function useAudioMemo(): AudioMemoContextValue {
  const context = useContext(AudioMemoContext)
  if (!context) {
    throw new Error('useAudioMemo must be used within an AudioMemoProvider')
  }
  return context
}
