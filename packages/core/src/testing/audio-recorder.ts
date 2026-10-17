import type {
  AudioRecorderFinalSegment,
  AudioRecorderSegment,
  AudioRecorderService,
  AudioRecorderState,
  AudioRecorderStopped,
  RecordingLevelEvent,
  RecordingNativeActionEvent,
  RecordingSessionStart,
  RecordingStatus,
  StagedRecordingFile,
  StartRecordingOptions,
} from '../audio/audio-recorder-service.ts'
import type { Unlisten } from '../unlisten.ts'

export type AudioRecorderCall =
  | { method: 'start'; options: StartRecordingOptions }
  | {
      method: 'stop' | 'cancel' | 'status' | 'listStaged' | 'actionsReady' | 'actionPerformed'
    }
  | { method: 'deleteStaged'; path: string }

export interface TestAudioRecorderService extends AudioRecorderService {
  /**
   * Every recorder call, in order.
   */
  calls(): readonly AudioRecorderCall[]
  /**
   * What the next `stop` resolves; `null` (a misclick) until set.
   */
  setStopResult(segment: AudioRecorderFinalSegment | null): void
  /**
   * Makes the next `start` reject with `error`, as a denied microphone does.
   */
  failNextStart(error: unknown): void
  /**
   * Parks the next `start` at `requesting`, as an open permission prompt
   * does. The returned function grants it; a `cancel` first resolves it `null`.
   */
  holdNextStart(): () => void
  /**
   * Parks the next `stop` with the state still `recording`. The returned
   * function lets it settle.
   */
  holdNextStop(): () => void
  setStaged(files: readonly StagedRecordingFile[]): void
  emitLevel(event: RecordingLevelEvent): void
  emitSegment(segment: AudioRecorderSegment): void
  /**
   * Ends the session as the recorder would, then notifies listeners.
   */
  emitStopped(stopped: AudioRecorderStopped): void
  emitReminder(elapsedMs: number): void
  emitNativeAction(event: RecordingNativeActionEvent): void
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

/**
 * An in-memory {@link AudioRecorderService}. `start` moves straight to
 * `recording` with the session stamp `sessionStartedMs`; `stop` and `cancel`
 * return to `idle`.
 */
class TestAudioRecorderServiceImpl implements TestAudioRecorderService {
  readonly #sessionStartedMs: number
  readonly #supported: boolean
  #state: AudioRecorderState = 'idle'
  #stopResult: AudioRecorderFinalSegment | null = null
  #startFailure: { error: unknown } | null = null
  #startHeld: Promise<void> | null = null
  /**
   * Settles the parked `start` as cancelled.
   */
  #cancelHeldStart: (() => void) | null = null
  #stopHeld: Promise<void> | null = null
  #staged: StagedRecordingFile[] = []
  readonly #log: AudioRecorderCall[] = []
  readonly #claimed = new Set<string>()
  readonly #stateListeners = new Set<(state: AudioRecorderState) => void>()
  readonly #levelListeners = new Set<(event: RecordingLevelEvent) => void>()
  readonly #segmentListeners = new Set<(segment: AudioRecorderSegment) => void>()
  readonly #stoppedListeners = new Set<(stopped: AudioRecorderStopped) => void>()
  readonly #reminderListeners = new Set<(elapsedMs: number) => void>()
  readonly #nativeActionListeners = new Set<(event: RecordingNativeActionEvent) => void>()

  constructor(options?: { sessionStartedMs?: number; supported?: boolean }) {
    this.#sessionStartedMs = options?.sessionStartedMs ?? 0
    this.#supported = options?.supported ?? true
  }

  isSupported(): boolean {
    return this.#supported
  }

  state(): AudioRecorderState {
    return this.#state
  }

  subscribeState(listener: (state: AudioRecorderState) => void): Unlisten {
    return subscribeTo(this.#stateListeners, listener)
  }

  stream(): MediaStream | null {
    return null
  }

  async start(startOptions: StartRecordingOptions): Promise<RecordingSessionStart | null> {
    this.#log.push({ method: 'start', options: { ...startOptions } })
    if (this.#state !== 'idle') {
      return null
    }
    if (this.#startFailure !== null) {
      const { error } = this.#startFailure
      this.#startFailure = null
      throw error
    }
    if (this.#startHeld !== null) {
      const held = this.#startHeld
      this.#startHeld = null
      this.#setState('requesting')
      const cancelled = Promise.withResolvers<boolean>()
      this.#cancelHeldStart = () => {
        cancelled.resolve(true)
      }
      const wasCancelled = await Promise.race([held.then(() => false), cancelled.promise])
      this.#cancelHeldStart = null
      if (wasCancelled) {
        return null
      }
    }
    this.#setState('recording')
    return { sessionStartedMs: this.#sessionStartedMs }
  }

  async stop(): Promise<AudioRecorderFinalSegment | null> {
    this.#log.push({ method: 'stop' })
    const result = this.#stopResult
    if (this.#stopHeld !== null) {
      const held = this.#stopHeld
      this.#stopHeld = null
      await held
    }
    this.#setState('idle')
    if (result?.audio.kind === 'staged') {
      this.#claimed.add(result.audio.path)
    }
    return result
  }

  cancel(): void {
    this.#log.push({ method: 'cancel' })
    this.#cancelHeldStart?.()
    this.#setState('idle')
    return
  }

  status(): RecordingStatus {
    this.#log.push({ method: 'status' })
    return { recording: this.#state === 'recording', elapsedMs: 0 }
  }

  listStaged(): StagedRecordingFile[] {
    this.#log.push({ method: 'listStaged' })
    return this.#staged.map((file) => ({ ...file }))
  }

  deleteStaged(path: string): void {
    this.#log.push({ method: 'deleteStaged', path })
    this.#staged = this.#staged.filter((file) => file.path !== path)
    return
  }

  claimStaged(path: string): void {
    this.#claimed.add(path)
  }

  releaseStaged(path: string): void {
    this.#claimed.delete(path)
  }

  isStagedClaimed(path: string): boolean {
    return this.#claimed.has(path)
  }

  actionsReady(_options?: { signal?: AbortSignal }): void {
    this.#log.push({ method: 'actionsReady' })
    return
  }

  actionPerformed(): void {
    this.#log.push({ method: 'actionPerformed' })
    return
  }

  subscribeLevel(listener: (event: RecordingLevelEvent) => void): Unlisten {
    return subscribeTo(this.#levelListeners, listener)
  }

  subscribeSegment(listener: (segment: AudioRecorderSegment) => void): Unlisten {
    return subscribeTo(this.#segmentListeners, listener)
  }

  subscribeStopped(listener: (stopped: AudioRecorderStopped) => void): Unlisten {
    return subscribeTo(this.#stoppedListeners, listener)
  }

  subscribeReminder(listener: (elapsedMs: number) => void): Unlisten {
    return subscribeTo(this.#reminderListeners, listener)
  }

  subscribeNativeAction(listener: (event: RecordingNativeActionEvent) => void): Unlisten {
    return subscribeTo(this.#nativeActionListeners, listener)
  }

  calls(): readonly AudioRecorderCall[] {
    return [...this.#log]
  }

  setStopResult(segment: AudioRecorderFinalSegment | null): void {
    this.#stopResult = segment
  }

  failNextStart(error: unknown): void {
    this.#startFailure = { error }
  }

  holdNextStart(): () => void {
    const held = Promise.withResolvers<void>()
    this.#startHeld = held.promise
    return held.resolve
  }

  holdNextStop(): () => void {
    const held = Promise.withResolvers<void>()
    this.#stopHeld = held.promise
    return held.resolve
  }

  setStaged(files: readonly StagedRecordingFile[]): void {
    this.#staged = [...files]
  }

  emitLevel(event: RecordingLevelEvent): void {
    emit(this.#levelListeners, event)
  }

  emitSegment(segment: AudioRecorderSegment): void {
    emit(this.#segmentListeners, segment)
  }

  emitStopped(stopped: AudioRecorderStopped): void {
    this.#setState('idle')
    emit(this.#stoppedListeners, stopped)
  }

  emitReminder(elapsedMs: number): void {
    emit(this.#reminderListeners, elapsedMs)
  }

  emitNativeAction(event: RecordingNativeActionEvent): void {
    emit(this.#nativeActionListeners, event)
  }

  #setState(next: AudioRecorderState): void {
    if (next === this.#state) {
      return
    }
    this.#state = next
    emit(this.#stateListeners, next)
  }
}

export function createTestAudioRecorderService(options?: {
  sessionStartedMs?: number
  supported?: boolean
}): TestAudioRecorderService {
  return new TestAudioRecorderServiceImpl(options)
}
