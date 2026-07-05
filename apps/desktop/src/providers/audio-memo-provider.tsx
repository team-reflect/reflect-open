import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  captureAudioMemo,
  errorMessage,
  pickTranscriptionConfig,
  type AiProvidersState,
  type GraphInfo,
} from '@reflect/core'
import { isRecordingSupported, useAudioRecorder } from '@/hooks/use-audio-recorder'
import { startOperation } from '@/lib/operations'
import {
  createTranscriptionReconciler,
  type TranscriptionReconciler,
} from '@/lib/transcription-reconciler'
import { isMainWindow } from '@/lib/window-role'
import { useSettings } from '@/providers/settings-provider'
import { useSidebar } from '@/providers/sidebar-provider'

/**
 * The React surface for audio memos: recording state + the bridge to the
 * core capture pipeline. State lives here — above the sidebar — because the
 * mic button unmounts with the sidebar (`Mod-\`), and a recording must never
 * outlive its UI invisibly: collapsing mid-recording stops and saves instead
 * of leaving a hidden hot microphone.
 *
 * The pipeline is raw-first (see `actions/audio-memo` in core): stopping a
 * recording writes the audio into the graph's `audio-memos/` — local,
 * instant — and transcription belongs to the per-graph
 * {@link createTranscriptionReconciler} lifecycle this provider mounts,
 * which owns every trigger and retry rule. Captures drain through a serial
 * queue so memos can be recorded back-to-back; a failed *capture* (the one
 * step that can lose audio) parks the queue behind a Retry/Discard error.
 */

/**
 * 'transcribing' means committed memos are still being captured or
 * transcribed in the background — the mic stays available, so the next
 * recording can start immediately.
 */
export type AudioMemoPhase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error'

/** A stopped recording waiting its turn through the capture queue. */
interface PendingCapture {
  audio: Blob
  mimeType: string
  recordedAt: Date
}

interface AudioMemoContextValue {
  phase: AudioMemoPhase
  /** Live while recording. */
  elapsedMs: number
  /** The live input stream, for the waveform. */
  stream: MediaStream | null
  /** Recordings committed but not yet written to the graph. */
  pendingCount: number
  /** False when no OpenAI/Gemini model is configured or the platform can't record. */
  available: boolean
  /** Why the mic is disabled (tooltip copy), null when `available`. */
  unavailableReason: string | null
  /** The failure shown in the error phase. */
  error: string | null
  /** True when a retry can re-run the failed capture. */
  canRetry: boolean
  /** Idle → start recording (expanding a collapsed sidebar); recording → stop & save. */
  toggle: () => void
  /** Discard the in-flight recording without saving. */
  cancel: () => void
  /** Re-run the failed capture. */
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
  const [resume, setResume] = useState<PendingCapture | null>(null)

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
        providers: settings.aiProviders,
        defaultProviderId: settings.defaultAiProviderId,
      }),
    [settings.aiProviders, settings.defaultAiProviderId],
  )

  const collapsedRef = useRef(collapsed)
  useEffect(() => {
    collapsedRef.current = collapsed
  })

  /** Committed recordings waiting their turn; the pump owns the head. */
  const queueRef = useRef<PendingCapture[]>([])
  /** Single-drainer guard: one pump loop at a time, one capture at a time. */
  const pumpingRef = useRef(false)
  /**
   * The failed capture a retry should re-run. While parked, the queue holds —
   * memo order in the graph must survive the failure. A ref, not state: rapid
   * double Retry must see the first click's take synchronously, or two
   * pipelines write the recording twice.
   */
  const parkedRef = useRef<PendingCapture | null>(null)
  /** Re-entry guard for the stop click's await gap. */
  const stoppingRef = useRef(false)
  /** The in-flight stop, so a mic click in the gap can chain the next memo. */
  const stopSettledRef = useRef<Promise<void>>(Promise.resolve())

  // The configured-models state, by ref: the reconciler reads it lazily at
  // the start of every pass, so a key added mid-session is seen without
  // rebuilding the lifecycle on every settings change.
  const providersRef = useRef<AiProvidersState>({
    providers: settings.aiProviders,
    defaultProviderId: settings.defaultAiProviderId,
  })
  useEffect(() => {
    providersRef.current = { providers: settings.aiProviders, defaultProviderId: settings.defaultAiProviderId }
  })

  // One reconciler per graph session (this provider remounts per graph). It
  // owns the launch pass and all retry triggers; the pump only schedules.
  const [reconciler, setReconciler] = useState<TranscriptionReconciler | null>(null)
  const reconcilerRef = useRef<TranscriptionReconciler | null>(null)
  useEffect(() => {
    // Main window only: two reconcilers would double-transcribe (and
    // double-bill) the same memos. Recording still works in a note window —
    // the saved memo is transcribed by the main window's reconciler, which
    // sees it arrive on the watcher stream.
    if (!isMainWindow()) {
      return
    }
    const next = createTranscriptionReconciler({
      generation: graph.generation,
      getProviders: () => providersRef.current,
    })
    setReconciler(next)
    reconcilerRef.current = next
    next.start()
    return () => {
      next.dispose()
      reconcilerRef.current = null
      setReconciler((current) => (current === next ? null : current))
    }
  }, [graph.generation])

  // Passes gate on a configured model before any IO — when the user adds the
  // first key mid-session, kick the pass that gate was suppressing.
  const hadConfigRef = useRef(transcriptionConfig !== null)
  useEffect(() => {
    const hasConfig = transcriptionConfig !== null
    if (hasConfig && !hadConfigRef.current) {
      reconciler?.schedule()
    }
    hadConfigRef.current = hasConfig
  }, [transcriptionConfig, reconciler])

  /** True while a reconcile pass has memos to transcribe. */
  const transcribing = useSyncExternalStore(
    reconciler?.subscribe ?? (() => () => {}),
    reconciler?.getTranscribing ?? (() => false),
  )

  const pump = useCallback(async (): Promise<void> => {
    if (pumpingRef.current) {
      return
    }
    pumpingRef.current = true
    let captured = false
    try {
      while (parkedRef.current === null) {
        const capture = queueRef.current.shift()
        if (capture === undefined) {
          break
        }
        let outcome: Awaited<ReturnType<typeof captureAudioMemo>>
        try {
          outcome = await captureAudioMemo({ ...capture, generation: graph.generation })
        } catch (cause) {
          outcome = { ok: false, message: errorMessage(cause) }
        } finally {
          setPendingCount((count) => count - 1)
        }
        if (outcome.ok) {
          captured = true
        } else {
          // Park the queue behind the failure: the capture is the one step
          // that can lose audio, and memo order in the graph must survive.
          parkedRef.current = capture
          setResume(capture)
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
    if (captured) {
      // The watcher reports the recording write (it tracks `audio-memos/`),
      // which feeds the sync engine's commit debounce like any note edit.
      // Transcription is kicked directly rather than waiting on the
      // watcher's own debounce to echo our write back.
      reconcilerRef.current?.schedule()
    }
  }, [graph.generation])

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
    const settled = (async (): Promise<void> => {
      try {
        const recording = await stopRecorder()
        if (recording !== null) {
          queueRef.current.push({
            audio: recording.blob,
            mimeType: recording.mimeType,
            recordedAt: new Date(),
          })
          setPendingCount((count) => count + 1)
          void pump()
        }
      } finally {
        stoppingRef.current = false
        setStopping(false)
      }
    })()
    stopSettledRef.current = settled
    return settled
  }, [stopRecorder, pump])
  useEffect(() => {
    stopAndSaveRef.current = () => void stopAndSave()
  })

  const discard = useCallback((): void => {
    parkedRef.current = null
    setError(null)
    setResume(null)
    void pump()
  }, [pump])

  const toggle = useCallback((): void => {
    if (recorder.status === 'recording') {
      if (stoppingRef.current) {
        // The click landed in the stop's await gap, where the button already
        // reads as the idle mic — honor it as "record the next memo" once
        // the recorder frees, instead of swallowing it on the re-entry guard.
        void stopSettledRef.current.then(() => start())
      } else {
        void stopAndSave()
      }
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
          : stopping || pendingCount > 0 || transcribing
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
