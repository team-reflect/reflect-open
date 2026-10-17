import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type {
  RecordingLevelEvent,
  RecordingSessionStart,
  RecordingStatus,
  StagedRecordingFile,
  StartRecordingOptions,
} from '../ipc/recording-plugin.ts'
import {
  MIN_RECORDING_DURATION_MS,
  type AudioRecorderFinalSegment,
  type AudioRecorderSegment,
  type AudioRecorderService,
  type AudioRecorderState,
} from './audio-recorder-service.ts'

/**
 * The part of a `MediaRecorder` the web recorder drives.
 */
export interface WebMediaRecorder {
  readonly state: RecordingState
  readonly mimeType: string
  ondataavailable: ((event: BlobEvent) => void) | null
  onstop: ((event: Event) => void) | null
  start(): void
  stop(): void
}

/**
 * The part of the `MediaRecorder` constructor the web recorder uses.
 */
export interface WebMediaRecorderConstructor {
  new (stream: MediaStream, options?: MediaRecorderOptions): WebMediaRecorder
  isTypeSupported(type: string): boolean
}

/**
 * The part of `navigator.mediaDevices` the web recorder uses.
 */
export interface WebMediaDevices {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
}

/**
 * Preference order matters per platform: Chrome and WebView2 take the
 * opus-in-webm entries; WKWebView supports none of them and falls through to
 * `audio/mp4` (AAC). Both containers are accepted by the transcription
 * providers.
 */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

/**
 * Speech-quality encode target. Left to its defaults, MediaRecorder picks
 * music-grade bitrates that roughly double a segment's size. Encoders clamp
 * unsupported values, never throw.
 */
const AUDIO_BITS_PER_SECOND = 64_000

const ELAPSED_TICK_MS = 200

const FALLBACK_MIME_TYPE = 'audio/mp4'

/**
 * Settle once `recorder` has stopped (immediately when it already has).
 */
function stopInstance(recorder: WebMediaRecorder): Promise<void> {
  return new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    if (recorder.state === 'inactive') {
      // Already stopped (a cancel raced us): its onstop may never fire, and
      // stop() on an inactive recorder throws.
      resolve()
    } else {
      recorder.stop()
    }
  })
}

function isUsableInterval(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0
}

function subscribeTo<Value>(
  listeners: Set<(value: Value) => void>,
  listener: (value: Value) => void,
): Unlisten {
  const entry = (value: Value): void => {
    listener(value)
  }
  listeners.add(entry)
  return () => {
    listeners.delete(entry)
  }
}

function emit<Value>(listeners: Set<(value: Value) => void>, value: Value): void {
  for (const listener of listeners) {
    listener(value)
  }
}

export interface WebAudioRecorderDeps {
  readonly clock: ClockService
  readonly mediaDevices?: WebMediaDevices
  readonly MediaRecorder?: WebMediaRecorderConstructor
}

class WebAudioRecorderImpl implements AudioRecorderService {
  readonly #deps: WebAudioRecorderDeps
  #state: AudioRecorderState = 'idle'
  readonly #stateListeners = new Set<(state: AudioRecorderState) => void>()
  readonly #levelListeners = new Set<(event: RecordingLevelEvent) => void>()
  readonly #segmentListeners = new Set<(segment: AudioRecorderSegment) => void>()
  readonly #reminderListeners = new Set<(elapsedMs: number) => void>()
  readonly #claimed = new Set<string>()

  #recorder: WebMediaRecorder | null = null
  #input: MediaStream | null = null
  #chunks: Blob[] = []
  #startedAt = 0
  #ticker: TimerHandle | null = null
  /**
   * Recorder constructor options, fixed per session so every segment matches.
   */
  #recorderInit: MediaRecorderOptions = {}
  #segmentMs = 0
  #reminderMs = 0
  /**
   * Segments emitted so far this session.
   */
  #parts = 0
  /**
   * Elapsed time the next rotation is due at, bumped when one is scheduled.
   */
  #rotateAt = 0
  /**
   * Reminder boundaries already crossed this session.
   */
  #reminders = 0
  /**
   * Serializes rotations against stop: each op awaits the previous onstop.
   */
  #opChain: Promise<void> = Promise.resolve()
  /**
   * Bumped by teardown, so an in-flight start resolves into a dead session.
   */
  #session = 0
  /**
   * Guards start's await gap, so overlapping starts acquire one stream.
   */
  #requesting = false
  #stopping: Promise<AudioRecorderFinalSegment | null> | null = null

  constructor(deps: WebAudioRecorderDeps) {
    this.#deps = deps
  }

  isSupported(): boolean {
    return (
      this.#recorderClass() !== undefined &&
      typeof this.#mediaDevices()?.getUserMedia === 'function'
    )
  }

  state(): AudioRecorderState {
    return this.#state
  }

  subscribeState(listener: (state: AudioRecorderState) => void): Unlisten {
    return subscribeTo(this.#stateListeners, listener)
  }

  stream(): MediaStream | null {
    return this.#input
  }

  async start(options: StartRecordingOptions): Promise<RecordingSessionStart | null> {
    const { clock } = this.#deps
    if (this.#requesting || this.#recorder !== null || this.#input !== null) {
      return null
    }
    const devices = this.#mediaDevices()
    if (devices === undefined) {
      throw new Error('mediaDevices is not available')
    }
    this.#requesting = true
    const owner = this.#session
    this.#setState('requesting')
    let stream: MediaStream
    try {
      stream = await devices.getUserMedia({ audio: true })
    } catch (error) {
      if (this.#currentSession() === owner) {
        this.#requesting = false
        this.#setState('idle')
      }
      throw error
    }
    if (this.#currentSession() !== owner) {
      // Cancelled while pending; a newer start may own `requesting` now.
      this.#stopTracks(stream)
      return null
    }
    this.#requesting = false

    const mimeType = this.#pickMimeType()
    this.#recorderInit = {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    }
    this.#segmentMs = options.segmentMs
    this.#reminderMs = options.reminderMs
    try {
      this.#chunks = []
      this.#parts = 0
      this.#rotateAt = this.#segmentMs
      this.#reminders = 0
      this.#attachRecorder(stream)
    } catch (error) {
      // A recorder that failed to set up must not strand the stream hot or
      // the state at `requesting`.
      this.#stopTracks(stream)
      this.#recorder = null
      this.#setState('idle')
      throw error
    }

    this.#input = stream
    this.#startedAt = clock.now()
    this.#ticker = clock.setInterval(() => {
      this.#tick()
    }, ELAPSED_TICK_MS)
    this.#setState('recording')
    return { sessionStartedMs: this.#startedAt }
  }

  stop(): Promise<AudioRecorderFinalSegment | null> {
    const { clock } = this.#deps
    // Concurrent stops share one in-flight promise: a second
    // MediaRecorder.stop() would throw and replace the first onstop.
    if (this.#stopping !== null) {
      return this.#stopping
    }
    if (this.#recorder === null) {
      this.#teardown()
      return Promise.resolve(null)
    }
    const stopped = (async (): Promise<AudioRecorderFinalSegment | null> => {
      await this.#opChain
      const current = this.#currentRecorder()
      if (current === null) {
        this.#teardown()
        return null
      }
      const durationMs = clock.now() - this.#startedAt
      await stopInstance(current)
      const mimeType = this.#mimeOf(current)
      const blob = new Blob(this.#chunks, { type: mimeType })
      if (this.#parts === 0 && (durationMs < MIN_RECORDING_DURATION_MS || blob.size === 0)) {
        this.#teardown()
        return null
      }
      // The final segment always ships, however small: it carries the
      // session's end marker.
      const final: AudioRecorderFinalSegment = {
        audio: { kind: 'blob', blob },
        mimeType,
        sessionStartedMs: this.#startedAt,
        part: this.#parts + 1,
        end: true,
        durationMs,
      }
      this.#teardown()
      return final
    })().finally(() => {
      this.#stopping = null
    })
    this.#stopping = stopped
    return stopped
  }

  cancel(): Promise<void> {
    const current = this.#recorder
    if (current !== null && current.state !== 'inactive') {
      current.onstop = null
      current.stop()
    }
    this.#teardown()
    return Promise.resolve()
  }

  status(): RecordingStatus {
    return {
      recording: this.#state === 'recording',
      elapsedMs: this.#state === 'recording' ? this.#deps.clock.now() - this.#startedAt : 0,
    }
  }

  listStaged(): StagedRecordingFile[] {
    return []
  }

  deleteStaged(): void {}

  claimStaged(path: string): void {
    this.#claimed.add(path)
  }

  releaseStaged(path: string): void {
    this.#claimed.delete(path)
  }

  isStagedClaimed(path: string): boolean {
    return this.#claimed.has(path)
  }

  async actionsReady(_options?: { signal?: AbortSignal }): Promise<void> {}

  async actionPerformed(): Promise<void> {}

  subscribeLevel(listener: (event: RecordingLevelEvent) => void): Unlisten {
    return subscribeTo(this.#levelListeners, listener)
  }

  subscribeSegment(listener: (segment: AudioRecorderSegment) => void): Unlisten {
    return subscribeTo(this.#segmentListeners, listener)
  }

  subscribeStopped(): Unlisten {
    return () => {}
  }

  subscribeReminder(listener: (elapsedMs: number) => void): Unlisten {
    return subscribeTo(this.#reminderListeners, listener)
  }

  subscribeNativeAction(): Unlisten {
    return () => {}
  }

  #recorderClass(): WebMediaRecorderConstructor | undefined {
    return (
      this.#deps.MediaRecorder ?? (typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder)
    )
  }

  #mediaDevices(): WebMediaDevices | undefined {
    return (
      this.#deps.mediaDevices ??
      (typeof globalThis.navigator === 'undefined' ? undefined : globalThis.navigator.mediaDevices)
    )
  }

  // Read through methods so narrowing from an earlier check does not
  // survive an await.
  #currentRecorder(): WebMediaRecorder | null {
    return this.#recorder
  }

  #currentSession(): number {
    return this.#session
  }

  #setState(next: AudioRecorderState): void {
    if (next === this.#state) {
      return
    }
    this.#state = next
    emit(this.#stateListeners, next)
  }

  #pickMimeType(): string | undefined {
    const MediaRecorderClass = this.#recorderClass()
    return MIME_CANDIDATES.find(
      (candidate) => MediaRecorderClass?.isTypeSupported(candidate) ?? false,
    )
  }

  #mimeOf(current: WebMediaRecorder): string {
    return current.mimeType || this.#pickMimeType() || FALLBACK_MIME_TYPE
  }

  #stopTracks(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      track.stop()
    }
  }

  #teardown(): void {
    this.#session += 1
    this.#requesting = false
    this.#recorder = null
    this.#chunks = []
    this.#parts = 0
    this.#rotateAt = 0
    this.#reminders = 0
    if (this.#ticker !== null) {
      this.#deps.clock.clearInterval(this.#ticker)
      this.#ticker = null
    }
    if (this.#input !== null) {
      this.#stopTracks(this.#input)
    }
    this.#input = null
    this.#setState('idle')
  }

  #attachRecorder(stream: MediaStream): WebMediaRecorder {
    const MediaRecorderClass = this.#recorderClass()
    if (MediaRecorderClass === undefined) {
      throw new Error('MediaRecorder is not available')
    }
    const next = new MediaRecorderClass(stream, this.#recorderInit)
    next.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.#chunks.push(event.data)
      }
    }
    next.start()
    this.#recorder = next
    return next
  }

  /**
   * Finish the current segment and start the next recorder on the same
   * stream. Chained so a stop arriving mid-rotation waits for the swap.
   */
  #rotate(): void {
    this.#opChain = this.#opChain.then(async () => {
      const current = this.#recorder
      const stream = this.#input
      if (current === null || stream === null || this.#stopping !== null) {
        return
      }
      const owner = this.#session
      await stopInstance(current)
      if (this.#currentSession() !== owner) {
        // Cancelled while the segment was flushing; teardown owns cleanup.
        return
      }
      const mimeType = this.#mimeOf(current)
      const blob = new Blob(this.#chunks, { type: mimeType })
      this.#chunks = []
      this.#parts += 1
      emit(this.#segmentListeners, {
        audio: { kind: 'blob', blob },
        mimeType,
        sessionStartedMs: this.#startedAt,
        part: this.#parts,
        end: false,
      })
      this.#attachRecorder(stream)
    })
  }

  #tick(): void {
    const elapsedMs = this.#deps.clock.now() - this.#startedAt
    emit(this.#levelListeners, { level: 0, elapsedMs })
    if (isUsableInterval(this.#segmentMs) && elapsedMs >= this.#rotateAt) {
      // Move the boundary when a rotation is scheduled, not when it lands:
      // `parts` only advances once the old recorder has flushed, so a flush
      // outliving a tick would queue a second rotation that cuts the fresh
      // recorder into a near-empty segment. Measuring from `elapsedMs` also
      // means a machine that slept through several boundaries rotates once.
      this.#rotateAt = elapsedMs + this.#segmentMs
      this.#rotate()
    }
    if (isUsableInterval(this.#reminderMs)) {
      // A machine that slept through several boundaries owes one nudge.
      const due = Math.floor(elapsedMs / this.#reminderMs)
      if (due > this.#reminders) {
        this.#reminders = due
        emit(this.#reminderListeners, elapsedMs)
      }
    }
  }
}

/**
 * The recorder over the webview's `MediaRecorder`. The microphone stream is
 * acquired once per session and stays open across rotations; only the
 * recorder attached to it is swapped, so each segment is a complete,
 * independently decodable container. Rotation and reminders run off elapsed
 * time on a short tick, so a throttled timer fires late but always fires.
 *
 * `MediaRecorder` and `mediaDevices` default to the globals, read at call
 * time. There is no staging directory and no native action, so those
 * methods are inert; level events carry the elapsed time with a level of 0,
 * and the waveform reads {@link AudioRecorderService.stream} instead.
 */
export function createWebAudioRecorder(deps: WebAudioRecorderDeps): AudioRecorderService {
  return new WebAudioRecorderImpl(deps)
}
