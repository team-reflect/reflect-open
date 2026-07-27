import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Microphone recording for audio memos: stream acquisition, a MediaRecorder
 * lifecycle that rotates every segment, and elapsed time — nothing else. The
 * microphone stream is acquired once per session and stays open across
 * rotations; only the recorder attached to it is swapped, so each segment is
 * a complete, independently decodable container and the seam between two
 * segments is the recorder swap, not a new permission round-trip. The
 * waveform taps the exposed stream itself, and capture/transcription belong
 * to the audio-memo provider, so this stays testable with two small global
 * stubs.
 */

export type RecorderStatus = 'idle' | 'requesting' | 'recording'

/** One finished segment, handed over the moment its recorder stopped. */
export interface RecorderSegment {
  blob: Blob
  /** The container the recorder actually produced (codec parameters intact). */
  mimeType: string
  /** 1-based position within the recording session. */
  part: number
  /** True on the session's final segment. */
  end: boolean
}

export interface RecorderResult {
  mimeType: string
  durationMs: number
  /** How many segments the session emitted via `onSegment`. */
  parts: number
}

export interface UseAudioRecorderOptions {
  /** Rotate the recorder each time the session grows by this much. */
  segmentMs?: number
  /** Auto-stop guard: `onMaxDuration` fires once when a session reaches this. */
  maxDurationMs?: number
  /** Called when the cap is hit — the host decides what stopping means. */
  onMaxDuration?: () => void
  /** Receives every finished segment, including the final one on stop. */
  onSegment?: (segment: RecorderSegment) => void
}

export interface UseAudioRecorderValue {
  status: RecorderStatus
  /** Live while recording; 0 otherwise. */
  elapsedMs: number
  /** The live input stream, for waveform visualization. */
  stream: MediaStream | null
  /** Ask for the microphone and start recording. Rejects when access is denied. */
  start: () => Promise<void>
  /** Stop, flush the final segment, and summarize — `null` for a misclick. */
  stop: () => Promise<RecorderResult | null>
  /** Stop and discard everything still unemitted. */
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
 * music-grade bitrates that roughly double a segment's size — which is disk,
 * sync traffic, and provider upload. Encoders clamp unsupported values,
 * never throw.
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

/** Settle once `recorder` has stopped (immediately when it already has). */
function stopInstance(recorder: MediaRecorder): Promise<void> {
  return new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    if (recorder.state === 'inactive') {
      // Already stopped (a cancel raced us): its onstop may never fire, and
      // stop() on an inactive recorder throws — settle immediately.
      resolve()
    } else {
      recorder.stop()
    }
  })
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
  /** Recorder constructor options, fixed per session so every segment matches. */
  const recorderInitRef = useRef<MediaRecorderOptions>({})
  /** Segments emitted so far this session. */
  const partsRef = useRef(0)
  const maxFiredRef = useRef(false)
  /** Serializes rotations against stop — each op awaits the previous onstop. */
  const opChainRef = useRef<Promise<void>>(Promise.resolve())
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
    partsRef.current = 0
    maxFiredRef.current = false
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop()
    }
    streamRef.current = null
    setStream(null)
    setElapsedMs(0)
    setStatus('idle')
  }, [])

  const currentMime = useCallback((recorder: MediaRecorder): string => {
    return recorder.mimeType || pickMimeType() || FALLBACK_MIME_TYPE
  }, [])

  const emitSegment = useCallback((blob: Blob, mimeType: string, end: boolean): void => {
    partsRef.current += 1
    optionsRef.current.onSegment?.({ blob, mimeType, part: partsRef.current, end })
  }, [])

  const attachRecorder = useCallback((input: MediaStream): MediaRecorder => {
    const recorder = new MediaRecorder(input, recorderInitRef.current)
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data)
      }
    }
    recorder.start()
    recorderRef.current = recorder
    return recorder
  }, [])

  const stopPromiseRef = useRef<Promise<RecorderResult | null> | null>(null)

  /**
   * Finish the current segment and start the next recorder on the same
   * stream. Chained so a stop arriving mid-rotation waits for the swap.
   */
  const rotate = useCallback((): void => {
    opChainRef.current = opChainRef.current.then(async () => {
      const recorder = recorderRef.current
      const input = streamRef.current
      if (recorder === null || input === null || stopPromiseRef.current !== null) {
        return
      }
      const session = sessionRef.current
      await stopInstance(recorder)
      if (sessionRef.current !== session) {
        // Cancelled while the segment was flushing; teardown owns cleanup.
        return
      }
      const mimeType = currentMime(recorder)
      const blob = new Blob(chunksRef.current, { type: mimeType })
      chunksRef.current = []
      emitSegment(blob, mimeType, false)
      attachRecorder(input)
    })
  }, [attachRecorder, currentMime, emitSegment])

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
    recorderInitRef.current = {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    }
    try {
      chunksRef.current = []
      partsRef.current = 0
      maxFiredRef.current = false
      attachRecorder(input)
    } catch (cause) {
      // A recorder that failed to set up must not strand the acquired stream
      // hot or the status at 'requesting'.
      for (const track of input.getTracks()) {
        track.stop()
      }
      recorderRef.current = null
      setStatus('idle')
      throw cause
    }

    streamRef.current = input
    startedAtRef.current = Date.now()
    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current
      setElapsedMs(elapsed)
      // Rotation and the cap run off elapsed time, not one long timeout — a
      // throttled webview timer may fire late, but it always fires.
      const segmentMs = optionsRef.current.segmentMs
      if (segmentMs !== undefined && elapsed >= (partsRef.current + 1) * segmentMs) {
        rotate()
      }
      const maxDurationMs = optionsRef.current.maxDurationMs
      if (maxDurationMs !== undefined && !maxFiredRef.current && elapsed >= maxDurationMs) {
        maxFiredRef.current = true
        optionsRef.current.onMaxDuration?.()
      }
    }, ELAPSED_TICK_MS)
    setStream(input)
    setStatus('recording')
  }, [attachRecorder, rotate])

  const stop = useCallback((): Promise<RecorderResult | null> => {
    // Concurrent stops (a click racing the collapse handler or the duration
    // cap) share one in-flight promise: a second MediaRecorder.stop() would
    // throw and replace the first caller's onstop resolver, stranding it.
    if (stopPromiseRef.current !== null) {
      return stopPromiseRef.current
    }
    if (recorderRef.current === null) {
      teardown()
      return Promise.resolve(null)
    }
    const stopped = (async (): Promise<RecorderResult | null> => {
      await opChainRef.current
      const recorder = recorderRef.current
      if (recorder === null) {
        teardown()
        return null
      }
      const durationMs = Date.now() - startedAtRef.current
      await stopInstance(recorder)
      const mimeType = currentMime(recorder)
      const blob = new Blob(chunksRef.current, { type: mimeType })
      if (partsRef.current === 0 && (durationMs < MIN_DURATION_MS || blob.size === 0)) {
        teardown()
        return null
      }
      // The final segment always ships, however small: it carries the
      // session's end marker, without which the session never closes.
      emitSegment(blob, mimeType, true)
      const parts = partsRef.current
      teardown()
      return { mimeType, durationMs, parts }
    })().finally(() => {
      stopPromiseRef.current = null
    })
    stopPromiseRef.current = stopped
    return stopped
  }, [currentMime, emitSegment, teardown])

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
