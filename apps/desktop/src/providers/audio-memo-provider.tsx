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
 */

export type AudioMemoPhase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error'

interface AudioMemoContextValue {
  phase: AudioMemoPhase
  /** Live while recording. */
  elapsedMs: number
  /** The live input stream, for the waveform. */
  stream: MediaStream | null
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
  /** Leave the error phase, dropping the failed payload. */
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

  const [saving, setSaving] = useState(false)
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

  // Re-entry guard: state-based `saving` flips a render too late to stop a
  // rapid second Retry, and two pipelines would append the transcript twice.
  const savingRef = useRef(false)

  const runSave = useCallback(
    async (payload: AudioMemoResume): Promise<void> => {
      if (savingRef.current) {
        return
      }
      savingRef.current = true
      setSaving(true)
      setError(null)
      try {
        const outcome = await saveAudioMemo({
          payload,
          models: { models: settings.aiModels, defaultModelId: settings.defaultAiModelId },
          date: todayIso(),
          generation: graph.generation,
          fetchFn: providerFetch,
        })
        if (outcome.ok) {
          setResume(null)
        } else {
          setError(outcome.message)
          setResume(outcome.resume)
          if (collapsedRef.current) {
            // The mic button (and its popover) unmounted with the sidebar —
            // the failure must still surface somewhere.
            startOperation('Saving audio memo').fail(outcome.message)
          }
        }
      } finally {
        savingRef.current = false
        setSaving(false)
      }
    },
    [settings.aiModels, settings.defaultAiModelId, graph.generation],
  )

  const start = useCallback(async (): Promise<void> => {
    if (!supported || transcriptionConfig === null) {
      return
    }
    setError(null)
    setResume(null)
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
    // The stop click commits the memo: flip to 'transcribing' before the stop
    // settles, so an Esc landing in the await gap can't read a lingering
    // 'recording' phase and cancel a recording the user just saved.
    setSaving(true)
    const recording = await stopRecorder()
    if (recording === null) {
      setSaving(false)
      return
    }
    await runSave({ kind: 'transcribe', audio: recording.blob, mimeType: recording.mimeType })
  }, [stopRecorder, runSave])
  stopAndSaveRef.current = () => void stopAndSave()

  const discard = useCallback((): void => {
    setError(null)
    setResume(null)
  }, [])

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
    } else if (recorder.status === 'idle' && !saving) {
      void start()
    }
  }, [recorder.status, saving, error, stopAndSave, cancelRecorder, start, toggleSidebar, discard])

  const cancel = useCallback((): void => {
    cancelRecorder()
    setError(null)
    setResume(null)
  }, [cancelRecorder])

  const retry = useCallback((): void => {
    if (resume !== null) {
      void runSave(resume)
    }
  }, [resume, runSave])

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

  const phase: AudioMemoPhase =
    error !== null
      ? 'error'
      : saving
        ? 'transcribing'
        : recorder.status === 'idle'
          ? 'idle'
          : recorder.status

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
