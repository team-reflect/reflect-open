import {
  createContext,
  useCallback,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  audioMemoIdentity,
  audioMemoPartPath,
  AUDIO_MEMO_SEGMENT_MS,
  deleteAudioMemo,
  errorMessage,
  listAudioMemoSegments,
  type GraphInfo,
} from '@reflect/core'
import { useAudioMemoPipeline } from '@/hooks/use-audio-memo-pipeline'
import { isNativeShell } from '@/lib/platform'
import type { AudioMemoPhase } from '@/providers/audio-memo-provider'
import { hapticImpactLight } from '@/mobile/haptics'
import {
  deleteStagedRecording,
  isMicDeniedError,
  NATIVE_RECORDING_MIME,
  releaseStagedPath,
  useNativeAudioRecorder,
  type NativeRecordingPart,
} from '@/mobile/use-native-audio-recorder'
import { useNativeRecordAction } from '@/mobile/use-native-record-action'
import { useStagedRecordingIngest } from '@/mobile/use-staged-recording-ingest'

/**
 * The mobile React surface for audio memos: the native recorder plugin over
 * the shared capture pipeline (`useAudioMemoPipeline` — the same serial
 * queue and transcription reconciler desktop uses). Desktop's provider
 * presents recording in a sidebar popover; here it is a bottom drawer plus a
 * mic FAB on the daily spine.
 *
 * Four mobile-only responsibilities live here:
 *
 * - **Segments and native stops.** The recorder rotates itself every
 *   {@link AUDIO_MEMO_SEGMENT_MS}, announcing each finished segment on the
 *   plugin's `recordingSegment` event; interruptions (calls, Siri) and
 *   input-route loss end the session on `recordingStopped`. Both are
 *   ingested exactly like a user stop. A session has no duration limit, and
 *   backgrounding is deliberately not a stop: `UIBackgroundModes: audio`
 *   keeps a memo capturing through screen lock (V1 parity).
 * - **The orphan scan** ({@link useStagedRecordingIngest}): staged segments
 *   the webview never saw land on mount and on every foreground.
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
  /** False without the native shell (the recorder is a native plugin). */
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

/**
 * The live recording session. The graph is its ledger, so this only carries
 * identity: unlike desktop, a session here can outlive the webview that
 * started it, and an in-memory list of captured paths would miss whatever a
 * previous webview ingested for the same recording.
 */
interface LiveSession {
  /** Identity derives from the session's start: every segment shares it. */
  recordedAt: Date
  cancelled: boolean
}

const MIC_DENIED_REASON = 'Microphone access was denied. Allow it for Reflect in the Settings app.'

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

  const sessionRef = useRef<LiveSession | null>(null)
  const generationRef = useRef(graph.generation)
  useEffect(() => {
    generationRef.current = graph.generation
  })

  /** Wrap a staged segment as a pipeline capture that owns the file. */
  const enqueuePart = useCallback(
    (part: NativeRecordingPart): void => {
      const memo = audioMemoIdentity(part.recordedAt, NATIVE_RECORDING_MIME)
      const path = audioMemoPartPath(memo, part.part, part.end)
      // Only the live session's segments answer to its cancel: a segment the
      // orphan scan found from an earlier run must not be swept away by
      // discarding the recording running now.
      const session = sessionRef.current
      const live =
        session !== null && session.recordedAt.getTime() === part.recordedAt.getTime()
          ? session
          : null
      const release = async (): Promise<void> => {
        // Always drop the claim, even if the delete fails: a still-claimed
        // path is skipped forever by the orphan scan, so a discarded memo
        // whose delete threw would otherwise reappear on the next launch.
        try {
          await deleteStagedRecording(part.stagedPath)
        } finally {
          releaseStagedPath(part.stagedPath)
        }
      }
      enqueuePipeline({
        audio: { sourcePath: part.stagedPath },
        mimeType: NATIVE_RECORDING_MIME,
        recordedAt: part.recordedAt,
        segment: { part: part.part, end: part.end },
        onCaptured: async () => {
          // A cancel that swept the directory before this segment's copy
          // landed has to be honored here instead.
          if (live?.cancelled === true) {
            await deleteAudioMemo(path, generationRef.current).catch(() => {})
          }
          await release()
        },
        onDiscarded: release,
      })
    },
    [enqueuePipeline],
  )

  const onNativeStop = useCallback(
    (part: NativeRecordingPart | null): void => {
      setDrawerOpen(false)
      setStopping(false)
      if (part !== null) {
        enqueuePart(part)
      }
      sessionRef.current = null
    },
    [enqueuePart, setDrawerOpen],
  )

  const recorder = useNativeAudioRecorder({
    segmentMs: AUDIO_MEMO_SEGMENT_MS,
    onSegment: enqueuePart,
    onNativeStop,
  })
  const startRecorder = recorder.start
  const stopRecorder = recorder.stop
  const cancelRecorder = recorder.cancel

  const available = isNativeShell()

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
      const recordedAt = await startRecorder()
      if (recordedAt !== null) {
        sessionRef.current = { recordedAt, cancelled: false }
      }
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
      const part = await stopRecorder()
      if (part !== null) {
        enqueuePart(part)
      }
      sessionRef.current = null
      hapticImpactLight()
    } catch (cause) {
      // A native stop (interruption, backgrounding) won the race — its
      // `recordingStopped` event delivers the memo instead.
      console.warn('stop raced a native finalize:', cause)
    } finally {
      stoppingRef.current = false
      setStopping(false)
    }
  }, [stopRecorder, enqueuePart, setDrawerOpen])

  const cancelRecording = useCallback((): void => {
    setDrawerOpen(false)
    const session = sessionRef.current
    if (session !== null) {
      // Discard means discard: every segment already in the graph goes too.
      // What is on disk is the only complete account of what this session
      // wrote, and the flag catches the segments still being copied.
      session.cancelled = true
      const memo = audioMemoIdentity(session.recordedAt, NATIVE_RECORDING_MIME)
      const generation = generationRef.current
      void (async () => {
        for (const path of await listAudioMemoSegments(memo, generation)) {
          await deleteAudioMemo(path, generation).catch(() => {})
        }
      })().catch((cause: unknown) => {
        console.error('discarding the recorded segments failed:', cause)
      })
    }
    void cancelRecorder()
      .catch((cause: unknown) => {
        console.warn('cancel raced a native finalize:', cause)
      })
      .finally(() => {
        if (sessionRef.current === session) {
          sessionRef.current = null
        }
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

  useNativeRecordAction({ start, enqueuePart })
  useStagedRecordingIngest(enqueuePart)

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

  return <MobileAudioMemoContext value={value}>{children}</MobileAudioMemoContext>
}

/** Access the mobile audio-memo surface. Use within MobileAudioMemoProvider. */
export function useMobileAudioMemo(): MobileAudioMemoContextValue {
  const context = use(MobileAudioMemoContext)
  if (!context) {
    throw new Error('useMobileAudioMemo must be used within a MobileAudioMemoProvider')
  }
  return context
}
