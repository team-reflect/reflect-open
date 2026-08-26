import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cancelRecording,
  deleteStaged,
  errorMessage,
  recordingStatus,
  startRecording,
  stopRecording,
  type RecordingSessionStart,
  subscribeRecordingLevel,
  subscribeRecordingSegment,
  subscribeRecordingStopped,
  type RecordingSegmentEvent,
  type RecordingStoppedEvent,
} from '@reflect/core'

/**
 * The mobile counterpart of `use-audio-recorder.ts`: the same
 * status/start/stop/cancel surface over the native recorder plugin
 * (`plugins/tauri-plugin-recording`) instead of the webview's MediaRecorder.
 * Capture is native by design (the V1 lesson): AVAudioRecorder writes
 * straight into a staging directory the plugin owns, rotates itself every
 * segment, and finalizes the file on interruptions and route loss without
 * JS — this hook only *presents* recording state and hands finished segments
 * to the capture pipeline. Backgrounding does not stop a recording (the app
 * declares `UIBackgroundModes: audio`); a session keeps capturing through
 * screen lock, has no duration limit, and ends only on a user stop or an
 * interruption.
 *
 * Instead of a `MediaStream` for the waveform, the plugin streams ~10 Hz
 * `recordingLevel` events; the latest level and elapsed time are exposed as
 * plain state.
 */

export type NativeRecorderStatus = 'idle' | 'requesting' | 'recording'

/** All recordings are AAC in an `.m4a` container (see RecordingPlugin.swift). */
export const NATIVE_RECORDING_MIME = 'audio/mp4'

/** Below this a recording is a misclick, not a memo (desktop parity). */
const MIN_DURATION_MS = 500

/** One finished segment of a recording session, staged and ready to ingest. */
export interface NativeRecordingPart {
  /** The staged file's absolute path; delete it once the graph write lands. */
  stagedPath: string
  /**
   * The session's start time, used as the memo's identity timestamp. Every
   * segment of one session shares it, and it is encoded in the staged
   * filename — so the live flow and the orphan scan file the same segment
   * under the same memo basename.
   */
  recordedAt: Date
  /** 1-based position within the session. */
  part: number
  /** True on the session's final segment (its file carries `-end`). */
  end: boolean
}

export interface UseNativeAudioRecorderOptions {
  /** Rotate the recorder this often, natively, so it holds if JS never wakes. */
  segmentMs: number
  /**
   * Remind the user this often while the session runs. The plugin owns the
   * schedule: a session the native side ends must clear the reminder even
   * when the webview is gone.
   */
  reminderMs: number
  /** A segment the recorder rotated away from; the session keeps recording. */
  onSegment: (part: NativeRecordingPart) => void
  /**
   * A stop the native side initiated (interruption, route change): the file
   * is already staged and `-end`-marked — treat it exactly like a user stop.
   * `null` when the session was too short to keep.
   */
  onNativeStop: (part: NativeRecordingPart | null) => void
}

export interface UseNativeAudioRecorderValue {
  status: NativeRecorderStatus
  /** Live while recording; 0 otherwise. */
  elapsedMs: number
  /** Latest input level 0…1, for the waveform. */
  level: number
  /**
   * Ask for the microphone and start a session. Resolves its identity
   * timestamp, or `null` when one was already live. Rejects when denied.
   */
  start: () => Promise<Date | null>
  /** Stop and hand back the final segment — `null` for a session too short to keep. */
  stop: () => Promise<NativeRecordingPart | null>
  /** Stop and discard everything. */
  cancel: () => Promise<void>
}

/**
 * Staged files a live flow (a stop in flight, a queued capture) already owns.
 * The orphan scan consults this so a file can never be ingested twice — once
 * by the stop that produced it and once by a scan racing the await gaps in
 * between. Module scope: one recorder surface per app, and claims must
 * survive a provider remount mid-capture.
 */
const claimedStagedPaths = new Set<string>()

/** Claim a staged file for a live capture flow. */
export function claimStagedPath(path: string): void {
  claimedStagedPaths.add(path)
}

/** Release a claim — after deletion, or so the orphan scan can retry it. */
export function releaseStagedPath(path: string): void {
  claimedStagedPaths.delete(path)
}

/** True when a live flow owns the staged file. */
export function isStagedPathClaimed(path: string): boolean {
  return claimedStagedPaths.has(path)
}

/** True when the native recorder rejected `start` because access was denied. */
export function isMicDeniedError(cause: unknown): boolean {
  return errorMessage(cause).includes('denied')
}

/** Remove a staged recording once its bytes are durable in the graph. */
export async function deleteStagedRecording(path: string): Promise<void> {
  await deleteStaged(path)
}

/**
 * Whether a native recording is live right now. A fresh mount checks this to
 * find a recording that outlived its JS (a webview reload or crash mid-memo).
 */
export async function nativeRecordingStatus(): Promise<{
  recording: boolean
  elapsedMs: number
}> {
  return await recordingStatus()
}

/**
 * Stop the live native session and claim its final segment — `null` for a
 * session too short to be a memo. The shared machinery behind the hook's
 * `stop` and the provider's mount-time reconcile of a recording that
 * outlived its UI. Rejects when nothing is recording (a native finalize won
 * the race — its `recordingStopped` event delivers the memo instead).
 */
export async function stopActiveRecording(): Promise<NativeRecordingPart | null> {
  const { path, sessionStartedMs, part, durationMs } = await stopRecording()
  claimStagedPath(path)
  // Only a one-segment session can be a misclick: a later segment always
  // ships, however small, because it carries the session's end marker.
  if (part === 1 && durationMs < MIN_DURATION_MS) {
    await deleteStagedRecording(path).catch(() => {})
    releaseStagedPath(path)
    return null
  }
  return { stagedPath: path, recordedAt: new Date(sessionStartedMs), part, end: true }
}

/**
 * Drive the native recorder plugin as a React hook. Subscribes to the
 * plugin's `recordingLevel` / `recordingSegment` / `recordingStopped` events
 * for the hook's whole life, exposes `status`/`elapsedMs`/`level` as state,
 * and returns `start`/`stop`/`cancel`. Rotated segments arrive on
 * `recordingSegment`; a native-initiated stop (interruption, route change)
 * arrives on `recordingStopped` and is delivered to
 * {@link UseNativeAudioRecorderOptions.onNativeStop}; user-initiated `stop`
 * resolves its own result.
 */
export function useNativeAudioRecorder(
  options: UseNativeAudioRecorderOptions,
): UseNativeAudioRecorderValue {
  const [status, setStatus] = useState<NativeRecorderStatus>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [level, setLevel] = useState(0)

  // Read at fire time, not captured at subscribe — the host's callback
  // identity changes across renders.
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })
  const statusRef = useRef<NativeRecorderStatus>('idle')
  // Read the live status through a function so control-flow narrowing from an
  // earlier guard (e.g. the `!== 'idle'` return in `start`) doesn't treat a
  // later read as still that literal — `setStatusBoth` mutates the ref
  // opaquely, and a `recordingStopped` event can change it across an await.
  const currentStatus = useCallback((): NativeRecorderStatus => statusRef.current, [])
  const setStatusBoth = useCallback((next: NativeRecorderStatus): void => {
    statusRef.current = next
    setStatus(next)
    if (next !== 'recording') {
      setElapsedMs(0)
      setLevel(0)
    }
  }, [])
  /** Guards the stop/cancel invoke gap — mirrors the desktop hook's guard. */
  const stopPromiseRef = useRef<Promise<NativeRecordingPart | null> | null>(null)

  // The plugin's event stream is subscribed for the hook's whole life: level
  // events are ignored unless recording, and a native stop must be heard even
  // if it lands between renders.
  useEffect(() => {
    const handleSegment = (event: RecordingSegmentEvent): void => {
      claimStagedPath(event.path)
      optionsRef.current.onSegment({
        stagedPath: event.path,
        recordedAt: new Date(event.sessionStartedMs),
        part: event.part,
        end: false,
      })
    }
    const handleStopped = (event: RecordingStoppedEvent): void => {
      setStatusBoth('idle')
      const { path, sessionStartedMs, part, durationMs } = event
      claimStagedPath(path)
      // Only a one-segment session can be a misclick: a later segment always
      // ships, however small, because it carries the session's end marker.
      if (part === 1 && durationMs < MIN_DURATION_MS) {
        void deleteStagedRecording(path).catch(() => {})
        releaseStagedPath(path)
        optionsRef.current.onNativeStop(null)
        return
      }
      optionsRef.current.onNativeStop({
        stagedPath: path,
        recordedAt: new Date(sessionStartedMs),
        part,
        end: true,
      })
    }
    const levelSubscription = subscribeRecordingLevel((event) => {
      if (statusRef.current === 'recording') {
        setLevel(event.level)
        setElapsedMs(event.elapsedMs)
      }
    })
    const segmentSubscription = subscribeRecordingSegment(handleSegment)
    const stoppedSubscription = subscribeRecordingStopped(handleStopped)
    void Promise.all([
      levelSubscription.ready,
      segmentSubscription.ready,
      stoppedSubscription.ready,
    ]).catch((cause: unknown) => {
      console.error('recording plugin events unavailable:', cause)
    })
    return () => {
      levelSubscription.unlisten()
      segmentSubscription.unlisten()
      stoppedSubscription.unlisten()
    }
  }, [setStatusBoth])

  const start = useCallback(async (): Promise<Date | null> => {
    if (currentStatus() !== 'idle') {
      return null
    }
    setStatusBoth('requesting')
    let session: RecordingSessionStart
    try {
      session = await startRecording({
        segmentMs: optionsRef.current.segmentMs,
        reminderMs: optionsRef.current.reminderMs,
      })
    } catch (cause) {
      setStatusBoth('idle')
      throw cause
    }
    // A `recordingStopped` event (interruption, permission race) can flip us
    // back to 'idle' while the start invoke is still in flight — don't
    // resurrect a recording that already finalized.
    if (currentStatus() === 'requesting') {
      setStatusBoth('recording')
    }
    return new Date(session.sessionStartedMs)
  }, [currentStatus, setStatusBoth])

  const stop = useCallback((): Promise<NativeRecordingPart | null> => {
    if (stopPromiseRef.current !== null) {
      return stopPromiseRef.current
    }
    if (statusRef.current !== 'recording') {
      return Promise.resolve(null)
    }
    const stopped = (async (): Promise<NativeRecordingPart | null> => {
      try {
        return await stopActiveRecording()
      } finally {
        setStatusBoth('idle')
      }
    })().finally(() => {
      stopPromiseRef.current = null
    })
    stopPromiseRef.current = stopped
    return stopped
  }, [setStatusBoth])

  const cancel = useCallback(async (): Promise<void> => {
    // Also aborts a pending permission request natively (start-session bump).
    try {
      await cancelRecording()
    } finally {
      setStatusBoth('idle')
    }
  }, [setStatusBoth])

  return { status, elapsedMs, level, start, stop, cancel }
}
