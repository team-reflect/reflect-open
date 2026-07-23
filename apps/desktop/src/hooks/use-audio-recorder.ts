import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Microphone recording for audio memos: stream acquisition, the MediaRecorder
 * lifecycle, and elapsed time — nothing else. The waveform taps the exposed
 * stream itself, and transcription belongs to the audio-memo provider, so this
 * stays testable with two small global stubs.
 */

export type RecorderStatus = 'idle' | 'requesting' | 'recording'

export interface RecorderResult {
  blob: Blob
  /** The container the recorder actually produced (codec parameters intact). */
  mimeType: string
  durationMs: number
}

export interface UseAudioRecorderOptions {
  /** Auto-stop guard: `onMaxDuration` fires once when a recording reaches this. */
  maxDurationMs?: number
  /** Called when the cap is hit — the host decides what stopping means. */
  onMaxDuration?: () => void
}

export interface UseAudioRecorderValue {
  status: RecorderStatus
  /** Live while recording; 0 otherwise. */
  elapsedMs: number
  /** The live input stream, for waveform visualization. */
  stream: MediaStream | null
  /** Ask for the microphone and start recording. Rejects when access is denied. */
  start: () => Promise<void>
  /** Stop and assemble the recording — `null` for one too short to be a memo. */
  stop: () => Promise<RecorderResult | null>
  /** Stop and discard everything. */
  cancel: () => void
}

/**
 * Preference order matters per platform: Chrome/WebView2 take the opus-in-webm
 * entries; WKWebView supports none of them and falls through to `audio/mp4`
 * (AAC). Both containers are accepted by the transcription providers.
 */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

/** Below this a recording is a misclick, not a memo. */
const MIN_DURATION_MS = 500

/**
 * Speech-quality encode target. Left to its defaults, MediaRecorder picks
 * music-grade bitrates that roughly double a meeting-length memo's size —
 * which is disk, sync traffic, and (for OpenAI's hard 25 MB request cap)
 * transcribable duration. Encoders clamp unsupported values, never throw.
 */
const AUDIO_BITS_PER_SECOND = 64_000

const ELAPSED_TICK_MS = 200

const FALLBACK_MIME_TYPE = 'audio/mp4'

function pickMimeType(): string | undefined {
  return MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate))
}

/** True when the platform exposes the recording APIs this hook needs. */
export function isRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  )
}

export function useAudioRecorder(options: UseAudioRecorderOptions = {}): UseAudioRecorderValue {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Read at fire time, not captured at start — the host's callback identity
  // changes across renders.
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })
  // Bumped by cancel/unmount so an in-flight getUserMedia resolves into a dead
  // session and releases the mic instead of recording into the void.
  const sessionRef = useRef(0)
  // Guards start()'s await gap: a second start() arriving while getUserMedia
  // is pending must not acquire a second stream and orphan the first.
  const requestingRef = useRef(false)

  const teardown = useCallback((): void => {
    sessionRef.current += 1
    requestingRef.current = false
    recorderRef.current = null
    chunksRef.current = []
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (maxTimeoutRef.current !== null) {
      clearTimeout(maxTimeoutRef.current)
      maxTimeoutRef.current = null
    }
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop()
    }
    streamRef.current = null
    setStream(null)
    setElapsedMs(0)
    setStatus('idle')
  }, [])

  const start = useCallback(async (): Promise<void> => {
    if (requestingRef.current || recorderRef.current !== null || streamRef.current !== null) {
      return
    }
    requestingRef.current = true
    const session = sessionRef.current
    setStatus('requesting')
    let input: MediaStream
    try {
      input = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (cause) {
      if (sessionRef.current === session) {
        requestingRef.current = false
        setStatus('idle')
      }
      throw cause
    }
    if (sessionRef.current !== session) {
      // Cancelled while pending; a newer start() may own requestingRef now.
      for (const track of input.getTracks()) {
        track.stop()
      }
      return
    }
    requestingRef.current = false

    const mimeType = pickMimeType()
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(input, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      })
      chunksRef.current = []
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }
      recorder.start()
    } catch (cause) {
      // A recorder that failed to set up must not strand the acquired stream
      // hot or the status at 'requesting'.
      for (const track of input.getTracks()) {
        track.stop()
      }
      setStatus('idle')
      throw cause
    }

    recorderRef.current = recorder
    streamRef.current = input
    startedAtRef.current = Date.now()
    intervalRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current)
    }, ELAPSED_TICK_MS)
    const maxDurationMs = optionsRef.current.maxDurationMs
    if (maxDurationMs !== undefined) {
      maxTimeoutRef.current = setTimeout(() => {
        optionsRef.current.onMaxDuration?.()
      }, maxDurationMs)
    }
    setStream(input)
    setStatus('recording')
  }, [])

  const stopPromiseRef = useRef<Promise<RecorderResult | null> | null>(null)

  const stop = useCallback((): Promise<RecorderResult | null> => {
    // Concurrent stops (a click racing the collapse handler or the duration
    // cap) share one in-flight promise: a second MediaRecorder.stop() would
    // throw and replace the first caller's onstop resolver, stranding it.
    if (stopPromiseRef.current !== null) {
      return stopPromiseRef.current
    }
    const recorder = recorderRef.current
    if (recorder === null) {
      teardown()
      return Promise.resolve(null)
    }
    const stopped = (async (): Promise<RecorderResult | null> => {
      const durationMs = Date.now() - startedAtRef.current
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
        if (recorder.state === 'inactive') {
          // Already stopped (a cancel raced us): its onstop may never fire,
          // and stop() on an inactive recorder throws — settle immediately.
          resolve()
        } else {
          recorder.stop()
        }
      })
      const mimeType = recorder.mimeType || pickMimeType() || FALLBACK_MIME_TYPE
      const blob = new Blob(chunksRef.current, { type: mimeType })
      teardown()
      if (durationMs < MIN_DURATION_MS || blob.size === 0) {
        return null
      }
      return { blob, mimeType, durationMs }
    })().finally(() => {
      stopPromiseRef.current = null
    })
    stopPromiseRef.current = stopped
    return stopped
  }, [teardown])

  const cancel = useCallback((): void => {
    const recorder = recorderRef.current
    if (recorder !== null && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }
    teardown()
  }, [teardown])

  // Never leave the mic open past unmount.
  useEffect(() => cancel, [cancel])

  return { status, elapsedMs, stream, start, stop, cancel }
}
