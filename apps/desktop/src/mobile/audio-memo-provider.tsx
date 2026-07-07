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
import { addPluginListener, invoke } from '@tauri-apps/api/core'
import { errorMessage, hasBridge, type GraphInfo } from '@reflect/core'
import { z } from 'zod'
import { useAudioMemoPipeline, type PendingAudioCapture } from '@/hooks/use-audio-memo-pipeline'
import type { AudioMemoPhase } from '@/providers/audio-memo-provider'
import { hapticImpactLight } from '@/mobile/haptics'
import {
  claimStagedPath,
  deleteStagedRecording,
  isMicDeniedError,
  isStagedPathClaimed,
  NATIVE_RECORDING_MIME,
  nativeRecordingStatus,
  readStagedRecording,
  releaseStagedPath,
  stopActiveRecording,
  useNativeAudioRecorder,
  type NativeRecorderResult,
} from '@/mobile/use-native-audio-recorder'

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
 * - **The live-recording reconcile.** A recording that outlived its JS — a
 *   webview reload or crash mid-memo, a provider remount — must never leave
 *   a hidden hot microphone: on mount, a still-live native recording is
 *   stopped and saved.
 * - **The orphan scan.** A recording whose stop the webview never saw (a
 *   crash, a kill while backgrounded) is still sitting in the plugin's
 *   staging directory: on mount and on every foreground, staged files no
 *   live flow owns are ingested, then deleted. Ingest is idempotent by stop
 *   time — a re-scan of a file whose delete failed rewrites the same
 *   `audio-memos/` path rather than duplicating the memo.
 * - **The native-action handshake.** OS entry points (Siri, the home-screen
 *   quick action, the lock-screen widget) queue a `recordAudio` request in
 *   the plugin, persisted until this surface confirms it ran — so a request
 *   arriving before the webview exists, or right before it dies, is neither
 *   lost nor double-run (`docs/porting/reflect-mobile/native-entry-points.md`).
 */

interface MobileAudioMemoContextValue {
  phase: AudioMemoPhase
  /** Live while recording. */
  elapsedMs: number
  /** Latest input level 0…1, for the waveform. */
  level: number
  /** Recordings committed but not yet written to the graph. */
  pendingCount: number
  /** False without the native bridge or a transcription-capable model. */
  available: boolean
  /** The failure shown in the error phase. */
  error: string | null
  /** True when a retry can re-run the failed capture. */
  canRetry: boolean
  /** The recording drawer's visibility. */
  drawerOpen: boolean
  /** FAB tap: idle → record; recording → stop & save; error → show it. */
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

const listStagedSchema = z.object({
  files: z.array(z.object({ path: z.string(), modifiedMs: z.number() })),
})

const nativeActionSchema = z.object({ action: z.string() })

/**
 * How long the recording UI must survive before a delivered native action is
 * confirmed (V1 parity): a webview crash during presentation must leave the
 * action queued so it re-fires on the next launch.
 */
const ACTION_CONFIRM_DELAY_MS = 2000

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
    (input: { blob: Blob; recordedAt: Date; stagedPath: string }): void => {
      const release = async (): Promise<void> => {
        await deleteStagedRecording(input.stagedPath)
        releaseStagedPath(input.stagedPath)
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
          recordedAt: new Date(),
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

  const available = hasBridge() && pipeline.hasTranscriptionConfig

  const start = useCallback(async (): Promise<void> => {
    if (!available) {
      return
    }
    setDrawerOpen(true)
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
          recordedAt: new Date(),
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

  const startRef = useRef(start)
  useEffect(() => {
    startRef.current = start
  })

  // The live-recording reconcile, then the native-action handshake — in that
  // order, so a queued "record" delivered at `actions_ready` can never race
  // the stop of a recording that outlived the previous webview.
  //
  // Reconcile: this mount did not start any recording, so a native one still
  // running (the webview reloaded or crashed mid-memo, or the provider
  // remounted across a graph switch) has no UI — stop and save it rather
  // than leave a hidden hot microphone.
  //
  // Handshake: claim the plugin's persisted action queue; a delivered
  // `recordAudio` starts a memo and is confirmed only once the recording UI
  // has survived presentation (an unconfirmed action re-fires next launch).
  // Confirmation is about delivery, not success — a mic-denied start still
  // confirms, or the queue would re-surface the same failure every launch.
  useEffect(() => {
    if (!hasBridge()) {
      return
    }
    let disposed = false
    let confirmTimer: ReturnType<typeof setTimeout> | null = null
    let unlisten: (() => void) | null = null
    void (async () => {
      try {
        const status = await nativeRecordingStatus()
        if (status.recording) {
          const result = await stopActiveRecording()
          if (result !== null) {
            enqueueStaged({
              blob: result.blob,
              recordedAt: new Date(),
              stagedPath: result.stagedPath,
            })
          }
        }
      } catch (cause) {
        // A user stop or native finalize winning the race lands here — the
        // memo arrives through that path (or the orphan scan) instead.
        console.warn('reconciling a live native recording failed:', cause)
      }
      if (disposed) {
        return
      }
      try {
        const listener = await addPluginListener('recording', 'nativeAction', (raw: unknown) => {
          const parsed = nativeActionSchema.safeParse(raw)
          if (disposed || !parsed.success || parsed.data.action !== 'recordAudio') {
            return
          }
          void startRef.current()
          confirmTimer = setTimeout(() => {
            void invoke('plugin:recording|action_performed').catch((cause: unknown) => {
              console.warn('confirming a native action failed:', cause)
            })
          }, ACTION_CONFIRM_DELAY_MS)
        })
        if (disposed) {
          void listener.unregister()
          return
        }
        unlisten = () => void listener.unregister()
        await invoke('plugin:recording|actions_ready')
      } catch (cause) {
        console.error('the native-action handshake is unavailable:', cause)
      }
    })()
    return () => {
      disposed = true
      if (confirmTimer !== null) {
        clearTimeout(confirmTimer)
      }
      unlisten?.()
    }
  }, [enqueueStaged])

  // The orphan scan: staged recordings no live flow owns — from a crash, a
  // webview reload, or a kill while backgrounded — are ingested on mount and
  // on every foreground, oldest first (list_staged sorts by name = by time).
  const scanningRef = useRef(false)
  useEffect(() => {
    if (!hasBridge()) {
      return
    }
    let disposed = false
    const scan = async (): Promise<void> => {
      if (scanningRef.current) {
        return
      }
      scanningRef.current = true
      try {
        const raw = await invoke('plugin:recording|list_staged')
        const { files } = listStagedSchema.parse(raw)
        for (const file of files) {
          if (disposed) {
            return
          }
          if (isStagedPathClaimed(file.path)) {
            continue
          }
          claimStagedPath(file.path)
          try {
            const blob = await readStagedRecording(file.path)
            enqueueStaged({
              blob,
              // The file's stop time, so a re-ingest after a failed delete
              // resolves to the same memo identity instead of a duplicate.
              recordedAt: new Date(file.modifiedMs),
              stagedPath: file.path,
            })
          } catch (cause) {
            releaseStagedPath(file.path)
            console.error('ingesting a staged recording failed:', cause)
          }
        }
      } catch (cause) {
        console.error('audio memo orphan scan failed:', cause)
      } finally {
        scanningRef.current = false
      }
    }
    void scan()
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void scan()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enqueueStaged])

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
