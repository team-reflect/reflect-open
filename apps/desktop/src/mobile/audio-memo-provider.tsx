import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { errorMessage, hasBridge, type GraphInfo } from '@reflect/core'
import { useAudioMemoPipeline, type PendingAudioCapture } from '@/hooks/use-audio-memo-pipeline'
import type { AudioMemoPhase } from '@/providers/audio-memo-provider'
import { hapticImpactLight } from '@/mobile/haptics'
import {
  deleteStagedRecording,
  isMicDeniedError,
  NATIVE_RECORDING_MIME,
  releaseStagedPath,
  useNativeAudioRecorder,
  type NativeRecorderResult,
} from '@/mobile/use-native-audio-recorder'
import { useNativeRecordAction } from '@/mobile/use-native-record-action'
import {
  useStagedRecordingIngest,
  type StagedRecordingInput,
} from '@/mobile/use-staged-recording-ingest'

/**
 * The mobile React surface for audio memos: the native recorder plugin over
 * the shared capture pipeline (`useAudioMemoPipeline` — the same serial
 * queue and transcription reconciler desktop uses). Desktop's provider
 * presents recording in a sidebar popover; here it is a bottom drawer plus a
 * mic FAB on the daily spine.
 *
 * Four mobile-only responsibilities live here:
 *
 * - **Native stops.** Interruptions (calls, Siri), input-route loss, and the
 *   duration cap finalize the recording natively and announce it on the
 *   plugin's `recordingStopped` event — ingested exactly like a user stop.
 *   Backgrounding is deliberately not a stop: `UIBackgroundModes: audio`
 *   keeps a memo capturing through screen lock (V1 parity).
 * - **The orphan scan** ({@link useStagedRecordingIngest}): staged
 *   recordings whose stop the webview never saw are ingested on mount and
 *   on every foreground.
 * - **The live-recording reconcile + native-action handshake**
 *   ({@link useNativeRecordAction}): a recording that outlived its JS is
 *   stopped and saved rather than left a hidden hot microphone, and OS
 *   entry points' queued `recordAudio` requests are claimed and confirmed.
 */

interface MobileAudioMemoContextValue {
  phase: AudioMemoPhase
  /** Live while recording. */
  elapsedMs: number
  /** Latest input level 0…1, for the waveform. */
  level: number
  /** Recordings committed but not yet written to the graph. */
  pendingCount: number
  /** False without the native bridge. */
  available: boolean
  /** False when no OpenAI/Gemini model is configured; the drawer then guides key setup. */
  hasTranscriptionConfig: boolean
  /** The failure shown in the error phase. */
  error: string | null
  /** True when a retry can re-run the failed capture. */
  canRetry: boolean
  /** The recording drawer's visibility. */
  drawerOpen: boolean
  /** FAB tap: idle → record (or key setup); recording → stop & save; error → show it. */
  toggle: () => void
  /** The drawer's stop control — commit the memo. */
  stopAndSave: () => void
  /** The drawer's discard control — drop the live recording. */
  cancelRecording: () => void
  /** Drawer dismissal: a live recording stops-and-saves, never silently drops. */
  onDrawerOpenChange: (open: boolean) => void
  /** Re-run the failed capture. */
  retry: () => void
  /** Drop the failed memo and let the queue continue. */
  discard: () => void
}

const MobileAudioMemoContext = createContext<MobileAudioMemoContextValue | null>(null)

/** Auto-stop cap: bounds the transcription payload (desktop parity). */
const MAX_DURATION_MS = 10 * 60_000

const MIC_DENIED_REASON =
  'Microphone access was denied. Allow it for Reflect in the Settings app.'

interface MobileAudioMemoProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function MobileAudioMemoProvider({
  graph,
  children,
}: MobileAudioMemoProviderProps): ReactElement {
  const [drawerOpen, setDrawerOpenState] = useState(false)
  /** True from the stop tap until the recorder hands over the file. */
  const [stopping, setStopping] = useState(false)

  // Synced synchronously, not through a render effect: the pump consults it
  // the instant a capture fails, which can land before React re-renders the
  // close that preceded the failure.
  const drawerOpenRef = useRef(drawerOpen)
  const setDrawerOpen = useCallback((open: boolean): void => {
    drawerOpenRef.current = open
    setDrawerOpenState(open)
  }, [])

  const pipeline = useAudioMemoPipeline({
    graph,
    isErrorSurfaceVisible: () => drawerOpenRef.current,
  })
  const enqueuePipeline = pipeline.enqueue

  /** Wrap a staged recording as a pipeline capture that owns the file. */
  const enqueueStaged = useCallback(
    (input: StagedRecordingInput): void => {
      const release = async (): Promise<void> => {
        // Always drop the claim, even if the delete fails: a still-claimed
        // path is skipped forever by the orphan scan, so a discarded memo
        // whose delete threw would otherwise reappear on the next launch.
        try {
          await deleteStagedRecording(input.stagedPath)
        } finally {
          releaseStagedPath(input.stagedPath)
        }
      }
      const capture: PendingAudioCapture = {
        audio: input.blob,
        mimeType: NATIVE_RECORDING_MIME,
        recordedAt: input.recordedAt,
        onCaptured: release,
        onDiscarded: release,
      }
      enqueuePipeline(capture)
    },
    [enqueuePipeline],
  )

  const onNativeStop = useCallback(
    (result: NativeRecorderResult | null): void => {
      setDrawerOpen(false)
      setStopping(false)
      if (result !== null) {
        enqueueStaged({
          blob: result.blob,
          recordedAt: result.recordedAt,
          stagedPath: result.stagedPath,
        })
      }
    },
    [enqueueStaged, setDrawerOpen],
  )

  const recorder = useNativeAudioRecorder({
    maxDurationMs: MAX_DURATION_MS,
    onNativeStop,
  })
  const startRecorder = recorder.start
  const stopRecorder = recorder.stop
  const cancelRecorder = recorder.cancel

  const available = hasBridge()

  const start = useCallback(async (): Promise<void> => {
    if (!available) {
      return
    }
    setDrawerOpen(true)
    // Recording never starts without a transcription key: the drawer opens on
    // its key-setup guidance instead. OS entry points (Siri, the widget, the
    // quick action) funnel through here too, so they surface the same guidance.
    if (!pipeline.hasTranscriptionConfig) {
      return
    }
    try {
      await startRecorder()
      hapticImpactLight()
    } catch (cause) {
      pipeline.reportError(isMicDeniedError(cause) ? MIC_DENIED_REASON : errorMessage(cause))
    }
  }, [available, startRecorder, pipeline, setDrawerOpen])

  /** Re-entry guard for the stop tap's await gap. */
  const stoppingRef = useRef(false)

  const stopAndSave = useCallback(async (): Promise<void> => {
    if (stoppingRef.current) {
      return
    }
    stoppingRef.current = true
    // The stop tap commits the memo: the drawer closes now, and the FAB's
    // 'transcribing' state carries the progress from here.
    setStopping(true)
    setDrawerOpen(false)
    try {
      const recording = await stopRecorder()
      if (recording !== null) {
        enqueueStaged({
          blob: recording.blob,
          recordedAt: recording.recordedAt,
          stagedPath: recording.stagedPath,
        })
      }
      hapticImpactLight()
    } catch (cause) {
      // A native stop (interruption, backgrounding) won the race — its
      // `recordingStopped` event delivers the memo instead.
      console.warn('stop raced a native finalize:', cause)
    } finally {
      stoppingRef.current = false
      setStopping(false)
    }
  }, [stopRecorder, enqueueStaged, setDrawerOpen])

  const cancelRecording = useCallback((): void => {
    setDrawerOpen(false)
    void cancelRecorder().catch((cause: unknown) => {
      console.warn('cancel raced a native finalize:', cause)
    })
  }, [cancelRecorder, setDrawerOpen])

  const toggle = useCallback((): void => {
    if (recorder.status === 'recording') {
      void stopAndSave()
    } else if (recorder.status === 'requesting') {
      void cancelRecorder().catch(() => {})
      setDrawerOpen(false)
    } else if (pipeline.error !== null) {
      // A parked error must never invisibly block recording — the FAB
      // reopens the drawer, which shows the failure with Retry/Discard.
      setDrawerOpen(true)
    } else if (recorder.status === 'idle') {
      void start()
    }
  }, [recorder.status, pipeline.error, stopAndSave, cancelRecorder, start, setDrawerOpen])

  const onDrawerOpenChange = useCallback(
    (open: boolean): void => {
      if (open) {
        setDrawerOpen(true)
        return
      }
      // Dismissing the drawer mid-recording saves — a swipe-down must never
      // silently drop audio (discarding is the explicit Cancel control).
      if (recorder.status === 'recording') {
        void stopAndSave()
      } else if (recorder.status === 'requesting') {
        void cancelRecorder().catch(() => {})
      }
      setDrawerOpen(false)
    },
    [recorder.status, stopAndSave, cancelRecorder, setDrawerOpen],
  )

  useNativeRecordAction({ start, enqueueStaged })
  useStagedRecordingIngest(enqueueStaged)

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

  const value = useMemo<MobileAudioMemoContextValue>(
    () => ({
      phase,
      elapsedMs: recorder.elapsedMs,
      level: recorder.level,
      pendingCount: pipeline.pendingCount,
      available,
      hasTranscriptionConfig: pipeline.hasTranscriptionConfig,
      error: pipeline.error,
      canRetry: pipeline.canRetry,
      drawerOpen,
      toggle,
      stopAndSave: () => void stopAndSave(),
      cancelRecording,
      onDrawerOpenChange,
      retry: pipeline.retry,
      discard: pipeline.discard,
    }),
    [
      phase,
      recorder.elapsedMs,
      recorder.level,
      pipeline.pendingCount,
      available,
      pipeline.hasTranscriptionConfig,
      pipeline.error,
      pipeline.canRetry,
      pipeline.retry,
      pipeline.discard,
      drawerOpen,
      toggle,
      stopAndSave,
      cancelRecording,
      onDrawerOpenChange,
    ],
  )

  return (
    <MobileAudioMemoContext.Provider value={value}>{children}</MobileAudioMemoContext.Provider>
  )
}

/** Access the mobile audio-memo surface. Use within MobileAudioMemoProvider. */
export function useMobileAudioMemo(): MobileAudioMemoContextValue {
  const context = useContext(MobileAudioMemoContext)
  if (!context) {
    throw new Error('useMobileAudioMemo must be used within a MobileAudioMemoProvider')
  }
  return context
}
