import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  captureAudioMemo,
  errorMessage,
  pickTranscriptionConfig,
  type AiProvidersState,
  type GraphInfo,
} from '@reflect/core'
import { useMainWindowEffect } from '@/hooks/use-main-window-effect'
import { startOperation } from '@/lib/operations'
import {
  createTranscriptionReconciler,
  type TranscriptionReconciler,
} from '@/lib/transcription-reconciler'
import { useSettings } from '@/providers/settings-provider'

/**
 * The platform-neutral half of the audio-memo surface: the serial capture
 * queue and the per-graph transcription-reconciler lifecycle. Desktop
 * (`AudioMemoProvider`, webview MediaRecorder) and mobile
 * (`MobileAudioMemoProvider`, the native recorder plugin) both drain their
 * recordings through this hook; what differs — how audio is recorded and how
 * the recording UI looks — stays in each provider.
 *
 * The pipeline is raw-first (see `actions/audio-memo` in core): a queued
 * recording is written into the graph's `audio-memos/` — local, instant — and
 * transcription belongs to the reconciler this hook mounts, which owns every
 * trigger and retry rule. Captures drain through a serial queue so memos can
 * be recorded back-to-back; a failed *capture* (the one step that can lose
 * audio) parks the queue behind a Retry/Discard error.
 */

/** A stopped recording waiting its turn through the capture queue. */
export interface PendingAudioCapture {
  audio: Blob
  mimeType: string
  recordedAt: Date
  /**
   * Runs after the recording's bytes are durably in the graph — mobile
   * deletes its native staged file here. A failure is logged, never parked:
   * the audio is already safe, and the worst case (the staged copy
   * lingering) re-ingests idempotently by its stop time.
   */
  onCaptured?: () => Promise<void> | void
  /** Runs when the user discards this capture after it failed to write. */
  onDiscarded?: () => Promise<void> | void
}

/** Configuration for {@link useAudioMemoPipeline}. */
export interface UseAudioMemoPipelineOptions {
  /** The open graph — pins captures/transcription and scopes the reconciler. */
  graph: GraphInfo
  /**
   * Whether the capture-error UI (popover, drawer) is on screen. When it is
   * not, a failed capture is also surfaced as a failed operation toast so the
   * error can never park the queue invisibly.
   */
  isErrorSurfaceVisible: () => boolean
}

/**
 * The audio-memo surface's platform-neutral state and actions: capture-queue
 * progress, the transcription flag, availability, the parked-error state, and
 * the enqueue/retry/discard/report-error controls each provider drives.
 */
export interface UseAudioMemoPipelineValue {
  /** Recordings committed but not yet written to the graph. */
  pendingCount: number
  /** True while a reconcile pass has memos to transcribe. */
  transcribing: boolean
  /** False when no OpenAI/Gemini model is configured. */
  hasTranscriptionConfig: boolean
  /** The failure shown in the error phase. */
  error: string | null
  /** True when a retry can re-run a failed capture. */
  canRetry: boolean
  /** Queue a stopped recording for capture into the graph. */
  enqueue: (capture: PendingAudioCapture) => void
  /** Surface a recorder failure (mic denied, hardware) in the error state. */
  reportError: (message: string) => void
  /** Re-run the failed capture. */
  retry: () => void
  /** Drop the failed memo (or clear a recorder error) and continue. */
  discard: () => void
}

/**
 * Mount the capture queue and the transcription reconciler for one graph
 * session. Mount exactly once per surface — the reconciler half is already
 * main-window-gated, but the queue is per-instance state.
 */
export function useAudioMemoPipeline(
  options: UseAudioMemoPipelineOptions,
): UseAudioMemoPipelineValue {
  const { graph } = options
  const { settings } = useSettings()

  const [pendingCount, setPendingCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [resume, setResume] = useState<PendingAudioCapture | null>(null)

  const hasTranscriptionConfig =
    pickTranscriptionConfig({
      providers: settings.aiProviders,
      defaultProviderId: settings.defaultAiProviderId,
    }) !== null

  /** Committed recordings waiting their turn; the pump owns the head. */
  const queueRef = useRef<PendingAudioCapture[]>([])
  /** Single-drainer guard: one pump loop at a time, one capture at a time. */
  const pumpingRef = useRef(false)
  /**
   * The failed capture a retry should re-run. While parked, the queue holds —
   * memo order in the graph must survive the failure. A ref, not state: rapid
   * double Retry must see the first click's take synchronously, or two
   * pipelines write the recording twice.
   */
  const parkedRef = useRef<PendingAudioCapture | null>(null)

  const errorSurfaceVisibleRef = useRef(options.isErrorSurfaceVisible)
  useEffect(() => {
    errorSurfaceVisibleRef.current = options.isErrorSurfaceVisible
  })

  // The configured-models state, by ref: the reconciler reads it lazily at
  // the start of every pass, so a key added mid-session is seen without
  // rebuilding the lifecycle on every settings change.
  const providersRef = useRef<AiProvidersState>({
    providers: settings.aiProviders,
    defaultProviderId: settings.defaultAiProviderId,
  })
  useEffect(() => {
    providersRef.current = {
      providers: settings.aiProviders,
      defaultProviderId: settings.defaultAiProviderId,
    }
  })
  const transcriptionFormatRef = useRef(settings.transcriptionFormat)
  useEffect(() => {
    transcriptionFormatRef.current = settings.transcriptionFormat
  })

  // One reconciler per graph session (the hosting provider remounts per
  // graph). It owns the launch pass and all retry triggers; the pump only
  // schedules. Main window only: two reconcilers would double-transcribe (and
  // double-bill) the same memos. Recording still works in a note window —
  // the saved memo is transcribed by the main window's reconciler, which
  // sees it arrive on the watcher stream.
  const [reconciler, setReconciler] = useState<TranscriptionReconciler | null>(null)
  const reconcilerRef = useRef<TranscriptionReconciler | null>(null)
  useMainWindowEffect(() => {
    const next = createTranscriptionReconciler({
      generation: graph.generation,
      getProviders: () => providersRef.current,
      getTranscriptionFormat: () => transcriptionFormatRef.current,
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
  const hadConfigRef = useRef(hasTranscriptionConfig)
  useEffect(() => {
    if (hasTranscriptionConfig && !hadConfigRef.current) {
      reconciler?.schedule()
    }
    hadConfigRef.current = hasTranscriptionConfig
  }, [hasTranscriptionConfig, reconciler])

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
          try {
            await capture.onCaptured?.()
          } catch (cause) {
            // The audio is already durable in the graph — a cleanup failure
            // must not park the queue behind it.
            console.error('audio memo post-capture cleanup failed:', cause)
          }
        } else {
          // Park the queue behind the failure: the capture is the one step
          // that can lose audio, and memo order in the graph must survive.
          parkedRef.current = capture
          setResume(capture)
          setError(outcome.message)
          if (!errorSurfaceVisibleRef.current()) {
            // The error UI is off screen — the failure must still surface
            // somewhere.
            startOperation('Saving audio memo').fail(outcome.message)
          }
        }
      }
    } finally {
      pumpingRef.current = false
    }
    if (captured) {
      // The watcher (or mobile's in-process write echo) reports the recording
      // write, which feeds the sync engine's commit debounce like any note
      // edit. Transcription is kicked directly rather than waiting on the
      // watcher's own debounce to echo our write back.
      reconcilerRef.current?.schedule()
    }
  }, [graph.generation])

  const enqueue = useCallback(
    (capture: PendingAudioCapture): void => {
      queueRef.current.push(capture)
      setPendingCount((count) => count + 1)
      void pump()
    },
    [pump],
  )

  const reportError = useCallback((message: string): void => {
    setError(message)
  }, [])

  const discard = useCallback((): void => {
    const parked = parkedRef.current
    parkedRef.current = null
    setError(null)
    setResume(null)
    if (parked !== null) {
      void (async () => {
        try {
          await parked.onDiscarded?.()
        } catch (cause) {
          console.error('audio memo discard cleanup failed:', cause)
        }
      })()
    }
    void pump()
  }, [pump])

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

  return {
    pendingCount,
    transcribing,
    hasTranscriptionConfig,
    error,
    canRetry: resume !== null,
    enqueue,
    reportError,
    retry,
    discard,
  }
}
