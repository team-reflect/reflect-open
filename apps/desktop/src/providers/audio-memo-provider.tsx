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
import { AUDIO_MEMO_MAX_DURATION_MS, errorMessage, type GraphInfo } from '@reflect/core'
import { isRecordingSupported, useAudioRecorder } from '@/hooks/use-audio-recorder'
import { useAudioMemoPipeline } from '@/hooks/use-audio-memo-pipeline'
import { useSettings } from '@/providers/settings-provider'
import { useSidebar } from '@/providers/sidebar-provider'

/**
 * The desktop React surface for audio memos: MediaRecorder recording state +
 * the bridge to the shared capture pipeline (`useAudioMemoPipeline`, which
 * owns the serial capture queue and the transcription reconciler). State
 * lives here — above the sidebar — because the mic button unmounts with the
 * sidebar (`Mod-\`), and a recording must never outlive its UI invisibly:
 * collapsing mid-recording stops and saves instead of leaving a hidden hot
 * microphone.
 */

/**
 * 'transcribing' means committed memos are still being captured or
 * transcribed in the background — the mic stays available, so the next
 * recording can start immediately.
 */
export type AudioMemoPhase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error'

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
  // Keep the settings subscription alive at the provider (matches the
  // pipeline hook's own read), so the mic enables the moment a key is added.
  useSettings()
  const { collapsed, toggleSidebar } = useSidebar()

  /** True from the stop click until the recorder hands over the blob. */
  const [stopping, setStopping] = useState(false)

  const stopAndSaveRef = useRef<() => void>(() => {})
  const recorder = useAudioRecorder({
    maxDurationMs: AUDIO_MEMO_MAX_DURATION_MS,
    onMaxDuration: () => stopAndSaveRef.current(),
  })
  // The hook's functions are stable; the wrapper object is not (elapsed ticks
  // remint it every render). Callbacks and effects must hang off the
  // functions, or the collapse effect re-fires on every recording tick.
  const startRecorder = recorder.start
  const stopRecorder = recorder.stop
  const cancelRecorder = recorder.cancel

  const supported = isRecordingSupported()

  const collapsedRef = useRef(collapsed)
  useEffect(() => {
    collapsedRef.current = collapsed
  })

  // The mic button (and its popover) unmount with the sidebar — while
  // collapsed, a capture failure must surface as a toast instead.
  const pipeline = useAudioMemoPipeline({
    graph,
    isErrorSurfaceVisible: () => !collapsedRef.current,
  })

  /** Re-entry guard for the stop click's await gap. */
  const stoppingRef = useRef(false)
  /** The in-flight stop, so a mic click in the gap can chain the next memo. */
  const stopSettledRef = useRef<Promise<void>>(Promise.resolve())

  const start = useCallback(async (): Promise<void> => {
    if (!supported || !pipeline.hasTranscriptionConfig) {
      return
    }
    if (collapsedRef.current) {
      // Never record without visible recording UI.
      toggleSidebar()
    }
    try {
      await startRecorder()
    } catch (cause) {
      pipeline.reportError(
        cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? micDeniedMessage()
          : errorMessage(cause),
      )
    }
  }, [supported, pipeline, toggleSidebar, startRecorder])

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
          pipeline.enqueue({
            audio: recording.blob,
            mimeType: recording.mimeType,
            recordedAt: new Date(),
          })
        }
      } finally {
        stoppingRef.current = false
        setStopping(false)
      }
    })()
    stopSettledRef.current = settled
    return settled
  }, [stopRecorder, pipeline])
  useEffect(() => {
    stopAndSaveRef.current = () => void stopAndSave()
  })

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
    } else if (pipeline.error !== null) {
      // A parked error must never invisibly block recording. Collapsed, the
      // error UI doesn't exist — surface it; visible, it was on screen and a
      // fresh record request acknowledges it (the same click the red mic
      // anchor handles).
      if (collapsedRef.current) {
        toggleSidebar()
      } else {
        pipeline.discard()
      }
    } else if (recorder.status === 'idle') {
      void start()
    }
  }, [recorder.status, pipeline, stopAndSave, cancelRecorder, start, toggleSidebar])

  const cancel = useCallback((): void => {
    cancelRecorder()
  }, [cancelRecorder])

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
        : pipeline.error !== null
          ? 'error'
          : stopping || pipeline.pendingCount > 0 || pipeline.transcribing
            ? 'transcribing'
            : 'idle'

  const unavailableReason = !supported
    ? UNSUPPORTED_REASON
    : !pipeline.hasTranscriptionConfig
      ? NO_PROVIDER_REASON
      : null

  const value = useMemo<AudioMemoContextValue>(
    () => ({
      phase,
      elapsedMs: recorder.elapsedMs,
      stream: recorder.stream,
      pendingCount: pipeline.pendingCount,
      available: unavailableReason === null,
      unavailableReason,
      error: pipeline.error,
      canRetry: pipeline.canRetry,
      toggle,
      cancel,
      retry: pipeline.retry,
      discard: pipeline.discard,
    }),
    [
      phase,
      recorder.elapsedMs,
      recorder.stream,
      pipeline.pendingCount,
      unavailableReason,
      pipeline.error,
      pipeline.canRetry,
      pipeline.retry,
      pipeline.discard,
      toggle,
      cancel,
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
