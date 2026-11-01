import type { LoggerService } from '../ports/logger-service.ts'
import type { IpcBridgeService, PluginSubscription } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { PluginEvent } from '../ipc/plugin.ts'
import {
  actionPerformedCommand,
  actionsReadyCommand,
  cancelRecordingCommand,
  deleteStagedCommand,
  listStagedCommand,
  recordingLevelEvent,
  recordingNativeActionEvent,
  recordingSegmentEvent,
  recordingStatusCommand,
  recordingStoppedEvent,
  startRecordingCommand,
  stopRecordingCommand,
  type RecordingLevelEvent,
  type RecordingNativeActionEvent,
  type RecordingSegmentEvent,
  type RecordingSessionStart,
  type RecordingStatus,
  type RecordingStoppedEvent,
  type RecordingStopResponse,
  type StagedRecordingFile,
  type StartRecordingOptions,
} from '../ipc/recording-plugin.ts'
import {
  MIN_RECORDING_DURATION_MS,
  type AudioRecorderFinalSegment,
  type AudioRecorderSegment,
  type AudioRecorderService,
  type AudioRecorderState,
  type AudioRecorderStopped,
} from './audio-recorder-service.ts'

/**
 * All native recordings are AAC in an `.m4a` container.
 */
export const NATIVE_RECORDING_MIME = 'audio/mp4'

export interface NativeAudioRecorderDeps {
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
}

/**
 * Fan one plugin event out to listeners. The native registration is made
 * on the first listener and dropped with the last, and each payload is
 * handled once however many listeners there are.
 */
class PluginEventFanOut<Payload, Value> {
  readonly #deps: NativeAudioRecorderDeps
  readonly #event: PluginEvent<Payload>
  readonly #handle: (payload: Payload, deliver: (value: Value) => void) => void
  readonly #listeners = new Set<(value: Value) => void>()
  #subscription: PluginSubscription | null = null

  readonly #deliver = (value: Value): void => {
    for (const listener of this.#listeners) {
      listener(value)
    }
  }

  constructor(
    deps: NativeAudioRecorderDeps,
    event: PluginEvent<Payload>,
    handle: (payload: Payload, deliver: (value: Value) => void) => void,
  ) {
    this.#deps = deps
    this.#event = event
    this.#handle = handle
  }

  subscribe(listener: (value: Value) => void): Unlisten {
    const { ipc, logger } = this.#deps
    const entry = (value: Value): void => {
      listener(value)
    }
    this.#listeners.add(entry)
    if (this.#subscription === null) {
      this.#subscription = this.#event(ipc, (payload) => {
        this.#handle(payload, this.#deliver)
      })
      this.#subscription.ready.catch((error: unknown) => {
        logger.error('recording plugin events unavailable', error)
      })
    }
    return () => {
      this.#listeners.delete(entry)
      if (this.#listeners.size === 0 && this.#subscription !== null) {
        this.#subscription.unlisten()
        this.#subscription = null
      }
    }
  }
}

class NativeAudioRecorderImpl implements AudioRecorderService {
  readonly #deps: NativeAudioRecorderDeps
  #state: AudioRecorderState = 'idle'
  readonly #stateListeners = new Set<(state: AudioRecorderState) => void>()
  readonly #claimed = new Set<string>()
  #stopping: Promise<AudioRecorderFinalSegment | null> | null = null
  readonly #levelEvents: PluginEventFanOut<RecordingLevelEvent, RecordingLevelEvent>
  readonly #segmentEvents: PluginEventFanOut<RecordingSegmentEvent, AudioRecorderSegment>
  readonly #stoppedEvents: PluginEventFanOut<RecordingStoppedEvent, AudioRecorderStopped>
  readonly #nativeActionEvents: PluginEventFanOut<
    RecordingNativeActionEvent,
    RecordingNativeActionEvent
  >

  constructor(deps: NativeAudioRecorderDeps) {
    this.#deps = deps
    this.#levelEvents = new PluginEventFanOut(deps, recordingLevelEvent, (event, deliver) => {
      if (this.#state === 'recording') {
        deliver(event)
      }
    })
    this.#segmentEvents = new PluginEventFanOut(deps, recordingSegmentEvent, (event, deliver) => {
      this.#claimed.add(event.path)
      deliver({
        audio: { kind: 'staged', path: event.path },
        mimeType: NATIVE_RECORDING_MIME,
        sessionStartedMs: event.sessionStartedMs,
        part: event.part,
        end: false,
      })
    })
    this.#stoppedEvents = new PluginEventFanOut(deps, recordingStoppedEvent, (event, deliver) => {
      this.#setState('idle')
      deliver({ segment: this.#claimFinal(event), reason: event.reason })
    })
    this.#nativeActionEvents = new PluginEventFanOut(
      deps,
      recordingNativeActionEvent,
      (event, deliver) => {
        deliver(event)
      },
    )
  }

  isSupported(): boolean {
    return true
  }

  state(): AudioRecorderState {
    return this.#state
  }

  subscribeState(listener: (state: AudioRecorderState) => void): Unlisten {
    const entry = (next: AudioRecorderState): void => {
      listener(next)
    }
    this.#stateListeners.add(entry)
    return () => {
      this.#stateListeners.delete(entry)
    }
  }

  stream(): MediaStream | null {
    return null
  }

  async start(options: StartRecordingOptions): Promise<RecordingSessionStart | null> {
    const { ipc } = this.#deps
    if (this.#currentState() !== 'idle') {
      return null
    }
    this.#setState('requesting')
    let session: RecordingSessionStart
    try {
      session = await startRecordingCommand(ipc, {
        request: { segmentMs: options.segmentMs, reminderMs: options.reminderMs },
      })
    } catch (error) {
      this.#setState('idle')
      throw error
    }
    // A `recordingStopped` event can end the session while the start is in
    // flight; do not resurrect it.
    if (this.#currentState() === 'requesting') {
      this.#setState('recording')
    }
    return session
  }

  stop(): Promise<AudioRecorderFinalSegment | null> {
    const { ipc } = this.#deps
    if (this.#stopping !== null) {
      return this.#stopping
    }
    const stopped = (async (): Promise<AudioRecorderFinalSegment | null> => {
      try {
        return this.#claimFinal(await stopRecordingCommand(ipc, {}))
      } finally {
        this.#setState('idle')
      }
    })().finally(() => {
      this.#stopping = null
    })
    this.#stopping = stopped
    return stopped
  }

  async cancel(): Promise<void> {
    // Also aborts a pending permission request natively.
    try {
      await cancelRecordingCommand(this.#deps.ipc, {})
    } finally {
      this.#setState('idle')
    }
  }

  status(): Promise<RecordingStatus> {
    return recordingStatusCommand(this.#deps.ipc, {})
  }

  async listStaged(): Promise<StagedRecordingFile[]> {
    return (await listStagedCommand(this.#deps.ipc, {})).files
  }

  async deleteStaged(path: string): Promise<void> {
    await deleteStagedCommand(this.#deps.ipc, { request: { path } })
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

  async actionsReady(options?: { signal?: AbortSignal }): Promise<void> {
    const { ipc } = this.#deps
    // A queued action is delivered on this call, so the `nativeAction`
    // listener must be registered first.
    const probe = recordingNativeActionEvent(ipc, () => {})
    try {
      await probe.ready
    } finally {
      probe.unlisten()
    }
    if (options?.signal?.aborted === true) {
      return
    }
    await actionsReadyCommand(ipc, {})
  }

  async actionPerformed(): Promise<void> {
    await actionPerformedCommand(this.#deps.ipc, {})
  }

  subscribeLevel(listener: (event: RecordingLevelEvent) => void): Unlisten {
    return this.#levelEvents.subscribe(listener)
  }

  subscribeSegment(listener: (segment: AudioRecorderSegment) => void): Unlisten {
    return this.#segmentEvents.subscribe(listener)
  }

  subscribeStopped(listener: (stopped: AudioRecorderStopped) => void): Unlisten {
    return this.#stoppedEvents.subscribe(listener)
  }

  // The plugin schedules reminders as notifications itself.
  subscribeReminder(): Unlisten {
    return () => {}
  }

  subscribeNativeAction(listener: (event: RecordingNativeActionEvent) => void): Unlisten {
    return this.#nativeActionEvents.subscribe(listener)
  }

  // Read through a method so narrowing from an earlier check does not
  // survive an await that a `recordingStopped` event can cross.
  #currentState(): AudioRecorderState {
    return this.#state
  }

  #setState(next: AudioRecorderState): void {
    if (next === this.#state) {
      return
    }
    this.#state = next
    for (const listener of this.#stateListeners) {
      listener(next)
    }
  }

  /**
   * Claim a finished session's last segment, or drop it as a misclick. Only a
   * one-segment session can be too short to keep: a later segment carries
   * the end marker the session needs to close.
   */
  #claimFinal(stop: RecordingStopResponse): AudioRecorderFinalSegment | null {
    this.#claimed.add(stop.path)
    if (stop.part === 1 && stop.durationMs < MIN_RECORDING_DURATION_MS) {
      void deleteStagedCommand(this.#deps.ipc, { request: { path: stop.path } }).catch(() => {})
      this.#claimed.delete(stop.path)
      return null
    }
    return {
      audio: { kind: 'staged', path: stop.path },
      mimeType: NATIVE_RECORDING_MIME,
      sessionStartedMs: stop.sessionStartedMs,
      part: stop.part,
      end: true,
      durationMs: stop.durationMs,
    }
  }
}

/**
 * The recorder over `plugins/tauri-plugin-recording`. Capture is native:
 * the plugin writes straight into a staging directory it owns, rotates
 * segments and schedules reminders itself, and finalizes the file on
 * interruptions without JS. This service presents that state and claims the
 * staged files it hands out.
 */
export function createNativeAudioRecorder(deps: NativeAudioRecorderDeps): AudioRecorderService {
  return new NativeAudioRecorderImpl(deps)
}
