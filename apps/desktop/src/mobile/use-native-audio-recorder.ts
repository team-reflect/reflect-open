import { useCallback, useEffect, useRef, useState } from 'react'
import {
  base64ToBytes,
  cancelRecording,
  deleteStaged,
  errorMessage,
  readStaged,
  recordingStatus,
  startRecording,
  stopRecording,
  subscribeRecordingLevel,
  subscribeRecordingStopped,
  type RecordingStoppedEvent,
} from '@reflect/core'

/**
 * The mobile counterpart of `use-audio-recorder.ts`: the same
 * status/start/stop/cancel surface over the native recorder plugin
 * (`plugins/tauri-plugin-recording`) instead of the webview's MediaRecorder.
 * Capture is native by design (the V1 lesson): AVAudioRecorder writes
 * straight into a staging directory the plugin owns, and interruptions,
 * route loss, and the duration cap all finalize the file without JS — this
 * hook only *presents* recording state and hands finished files to the
 * capture pipeline. Backgrounding does not stop a recording (the app
 * declares `UIBackgroundModes: audio`); a memo keeps capturing through
 * screen lock and is stopped by the user, the cap, or an interruption.
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

export interface NativeRecorderResult {
  blob: Blob
  mimeType: string
  durationMs: number
  /** The staged file's absolute path — delete it once the blob is durable. */
  stagedPath: string
  /**
   * The recording's stop time (the staged file's mtime), used as the memo's
   * identity timestamp. Every ingest path — user stop, native stop, and the
   * orphan scan — keys off this same value, so re-ingesting a file whose
   * delete failed resolves to the same memo basename rather than a duplicate.
   */
  recordedAt: Date
}

export interface UseNativeAudioRecorderOptions {
  /** Auto-stop cap, enforced natively so it holds even if JS never wakes. */
  maxDurationMs: number
  /**
   * A stop the native side initiated (interruption, route change, the cap):
   * the file is already staged — treat it exactly like a user stop. `null`
   * when the recording was too short to keep.
   */
  onNativeStop: (result: NativeRecorderResult | null) => void
}

export interface UseNativeAudioRecorderValue {
  status: NativeRecorderStatus
  /** Live while recording; 0 otherwise. */
  elapsedMs: number
  /** Latest input level 0…1, for the waveform. */
  level: number
  /** Ask for the microphone and start recording. Rejects when denied. */
  start: () => Promise<void>
  /** Stop and read back the recording — `null` for one too short to keep. */
  stop: () => Promise<NativeRecorderResult | null>
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

/** Read a staged recording back as the pipeline's blob. */
export async function readStagedRecording(path: string): Promise<Blob> {
  const base64 = await readStaged(path)
  return new Blob([base64ToBytes(base64)], { type: NATIVE_RECORDING_MIME })
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
 * Stop the live native recording, claim its staged file, and read it back —
 * `null` for one too short to be a memo. The shared machinery behind the
 * hook's `stop` and the provider's mount-time reconcile of a recording that
 * outlived its UI. Rejects when nothing is recording (a native finalize won
 * the race — its `recordingStopped` event delivers the memo instead).
 */
export async function stopActiveRecording(): Promise<NativeRecorderResult | null> {
  const { path, durationMs, modifiedMs } = await stopRecording()
  claimStagedPath(path)
  if (durationMs < MIN_DURATION_MS) {
    await deleteStagedRecording(path).catch(() => {})
    releaseStagedPath(path)
    return null
  }
  try {
    const blob = await readStagedRecording(path)
    return {
      blob,
      mimeType: NATIVE_RECORDING_MIME,
      durationMs,
      stagedPath: path,
      recordedAt: new Date(modifiedMs),
    }
  } catch (cause) {
    // Leave the file for the orphan scan rather than losing the memo.
    releaseStagedPath(path)
    throw cause
  }
}

/**
 * Drive the native recorder plugin as a React hook. Subscribes to the
 * plugin's `recordingLevel` / `recordingStopped` events for the hook's whole
 * life, exposes `status`/`elapsedMs`/`level` as state, and returns
 * `start`/`stop`/`cancel`. A native-initiated stop (interruption, route
 * change, the duration cap) arrives on `recordingStopped` and is delivered to
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
  const stopPromiseRef = useRef<Promise<NativeRecorderResult | null> | null>(null)

  // The plugin's event stream is subscribed for the hook's whole life: level
  // events are ignored unless recording, and a native stop must be heard even
  // if it lands between renders.
  useEffect(() => {
    const handleStopped = (event: RecordingStoppedEvent): void => {
      setStatusBoth('idle')
      const { path, durationMs, modifiedMs } = event
      claimStagedPath(path)
      void (async () => {
        if (durationMs < MIN_DURATION_MS) {
          await deleteStagedRecording(path).catch(() => {})
          releaseStagedPath(path)
          optionsRef.current.onNativeStop(null)
          return
        }
        try {
          const blob = await readStagedRecording(path)
          optionsRef.current.onNativeStop({
            blob,
            mimeType: NATIVE_RECORDING_MIME,
            durationMs,
            stagedPath: path,
            recordedAt: new Date(modifiedMs),
          })
        } catch (cause) {
          // Reading it back failed — leave the file staged (released,
          // so the orphan scan ingests it on the next launch or
          // foreground instead). Still notify the host so the recording
          // UI closes: the recorder is already idle, and leaving the
          // drawer open would strand it.
          releaseStagedPath(path)
          console.error('reading a native-stopped recording failed:', cause)
          optionsRef.current.onNativeStop(null)
        }
      })()
    }
    const levelSubscription = subscribeRecordingLevel((event) => {
      if (statusRef.current === 'recording') {
        setLevel(event.level)
        setElapsedMs(event.elapsedMs)
      }
    })
    const stoppedSubscription = subscribeRecordingStopped(handleStopped)
    void Promise.all([levelSubscription.ready, stoppedSubscription.ready]).catch(
      (cause: unknown) => {
        console.error('recording plugin events unavailable:', cause)
      },
    )
    return () => {
      levelSubscription.unlisten()
      stoppedSubscription.unlisten()
    }
  }, [setStatusBoth])

  const start = useCallback(async (): Promise<void> => {
    if (currentStatus() !== 'idle') {
      return
    }
    setStatusBoth('requesting')
    try {
      await startRecording({ maxDurationMs: optionsRef.current.maxDurationMs })
    } catch (cause) {
      setStatusBoth('idle')
      throw cause
    }
    // A `recordingStopped` event (interruption, immediate cap, permission
    // race) can flip us back to 'idle' while the start invoke is still in
    // flight — don't resurrect a recording that already finalized.
    if (currentStatus() === 'requesting') {
      setStatusBoth('recording')
    }
  }, [currentStatus, setStatusBoth])

  const stop = useCallback((): Promise<NativeRecorderResult | null> => {
    if (stopPromiseRef.current !== null) {
      return stopPromiseRef.current
    }
    if (statusRef.current !== 'recording') {
      return Promise.resolve(null)
    }
    const stopped = (async (): Promise<NativeRecorderResult | null> => {
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
