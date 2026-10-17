import type { MaybePromise } from '@reflect/utils'
import {
  AUDIO_MEMO_REMINDER_MS,
  AUDIO_MEMO_SEGMENT_MS,
  type AudioMemoIdentity,
} from './audio-memo-session.ts'
import { audioMemoIdentity, audioMemoPartFromPath, audioMemoPartPath } from './audio-memo.ts'
import type { AiCredentialService } from '../ai/ai-credential-service.ts'
import type { AiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import type { TranscriptEnrichmentService } from '../ai/transcript-enrichment-service.ts'
import type { TranscriptionService } from '../ai/transcription-service.ts'
import type { BackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import type { ClockService } from '../ports/clock-service.ts'
import {
  requireGraphSession,
  type GraphRole,
  type GraphSessionSource,
} from '../graph/graph-session.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import type { BacklinkTargetService } from '../capture/backlink-target-service.ts'
import { errorMessage } from '../errors.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { AUDIO_MEMOS_DIR } from '../graph/paths.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import {
  createAudioMemoTranscriptionService,
  type AudioMemoTranscriptionService,
  type AudioMemoTranscriptionSession,
} from './audio-memo-transcription-service.ts'
import type {
  AudioRecorderSegment,
  AudioRecorderService,
  AudioRecorderState,
  RecordedAudio,
} from './audio-recorder-service.ts'

export interface CaptureAudioMemoPartInput {
  /**
   * One finished segment, as the recorder produced it.
   */
  audio: RecordedAudio
  /**
   * The segment's MIME type, possibly with codec parameters.
   */
  mimeType: string
  /**
   * When the *session* started — every part shares the session identity.
   */
  recordedAt: Date
  /**
   * 1-based position within the session.
   */
  part: number
  /**
   * True on the session's final segment.
   */
  end: boolean
}

/**
 * Expected failures are data: the caller retries with the same recording.
 */
export type CaptureAudioMemoOutcome =
  | { ok: true; memo: AudioMemoIdentity }
  | { ok: false; message: string }

/**
 * A stopped recording waiting its turn through the capture queue.
 */
export interface PendingAudioCapture {
  audio: RecordedAudio
  mimeType: string
  recordedAt: Date
  /**
   * Placement within the recording session this segment belongs to.
   */
  segment: { part: number; end: boolean }
  /**
   * Runs after the recording's bytes are durably in the graph — mobile
   * deletes its native staged file here. A failure is logged, never parked:
   * the audio is already safe, and the worst case (the staged copy
   * lingering) re-ingests idempotently by its stop time.
   */
  onCaptured?: () => MaybePromise<void>
  /**
   * Runs when the user discards this capture after it failed to write.
   */
  onDiscarded?: () => MaybePromise<void>
}

/**
 * What an {@link AudioMemoPipeline} shows of itself.
 */
export interface AudioMemoPipelineState {
  /**
   * Recordings committed but not yet written to the graph.
   */
  readonly pendingCount: number
  /**
   * True while a reconcile pass has memos to transcribe.
   */
  readonly transcribing: boolean
  /**
   * False when no OpenAI/Gemini model is configured.
   */
  readonly hasTranscriptionConfig: boolean
  /**
   * The failure shown in the error phase.
   */
  readonly error: string | null
  /**
   * True when a retry can re-run a failed capture.
   */
  readonly canRetry: boolean
}

export interface AudioMemoPipelineOptions {
  /**
   * Whether the capture-error UI (popover, drawer) is on screen. When it is
   * not, a failed capture is also surfaced as a failed operation so the
   * error can never park the queue invisibly.
   */
  isErrorSurfaceVisible: () => boolean
}

/**
 * The platform-neutral half of the audio-memo surface for one graph session:
 * the serial capture queue and the transcription lifecycle. The desktop
 * session ({@link AudioMemoSession}, webview MediaRecorder) and the mobile
 * session (`MobileAudioMemoService`, the native recorder plugin) both drain
 * their recordings through one; what differs — how audio is recorded and how
 * the recording UI looks — stays in each session.
 *
 * The pipeline is raw-first: a queued recording is written into the graph's
 * `audio-memos/` — local, instant — and transcription belongs to the
 * lifecycle this mounts, which owns every trigger and retry rule. Captures
 * drain through a serial queue so memos can be recorded back-to-back; a
 * failed *capture* (the one step that can lose audio) parks the queue behind
 * a Retry/Discard error.
 */
export interface AudioMemoPipeline {
  /**
   * The current state. The same object until something changes.
   */
  getState(): AudioMemoPipelineState
  subscribe(listener: () => void): Unlisten
  /**
   * Queue a stopped recording for capture into the graph.
   */
  enqueue(capture: PendingAudioCapture): void
  /**
   * Surface a recorder failure (mic denied, hardware) in the error state.
   */
  reportError(message: string): void
  /**
   * Re-run the failed capture.
   */
  retry(): void
  /**
   * Drop the failed memo (or clear a recorder error) and continue.
   */
  discard(): void
  /**
   * Graph paths of every segment of one recording, in listing order. The
   * cancel sweep's account of what a recording wrote: an in-memory ledger
   * cannot see segments a previous webview ingested for the same recording.
   */
  listSegments(memo: AudioMemoIdentity): Promise<string[]>
  /**
   * Delete one segment from the graph. Idempotent.
   */
  deleteSegment(path: string): Promise<void>
  /**
   * Stop the transcription lifecycle. Queued captures still drain.
   */
  dispose(): void
}

/**
 * 'transcribing' means committed memos are still being captured or
 * transcribed in the background — the mic stays available, so the next
 * recording can start immediately.
 */
export type AudioMemoPhase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error'

/**
 * The recording UI of a desktop {@link AudioMemoSession}, as its host shows it.
 */
export interface AudioMemoSurface {
  /**
   * Bring the hidden recording UI on screen (expand the collapsed sidebar).
   */
  reveal(): void
  /**
   * Tell the user the session is still running; `stopAndSave` ends it.
   */
  showReminder(elapsedMs: number, stopAndSave: () => void): void
  dismissReminder(): void
}

export interface AudioMemoSessionOptions {
  surface: AudioMemoSurface
  /**
   * Whether the recording UI is hidden when the session opens.
   */
  surfaceHidden: boolean
}

/**
 * What a desktop {@link AudioMemoSession} shows of itself.
 */
export interface AudioMemoSessionState {
  readonly phase: AudioMemoPhase
  /**
   * Live while recording.
   */
  readonly elapsedMs: number
  /**
   * The live input stream, for the waveform.
   */
  readonly stream: MediaStream | null
  /**
   * Recordings committed but not yet written to the graph.
   */
  readonly pendingCount: number
  /**
   * False when no OpenAI/Gemini model is configured or the platform can't record.
   */
  readonly available: boolean
  /**
   * Why the mic is disabled (tooltip copy), null when `available`.
   */
  readonly unavailableReason: string | null
  /**
   * The failure shown in the error phase.
   */
  readonly error: string | null
  /**
   * True when a retry can re-run the failed capture.
   */
  readonly canRetry: boolean
  /**
   * The recorder behind the phase.
   */
  readonly recorderState: AudioRecorderState
}

/**
 * The desktop audio-memo surface for one graph session: the webview recorder
 * over an {@link AudioMemoPipeline}. The session lives above the recording UI
 * because the mic button unmounts with the sidebar, and a recording must
 * never outlive its UI invisibly: hiding the UI mid-recording stops and saves
 * instead of leaving a hidden hot microphone.
 */
export interface AudioMemoSession {
  /**
   * The current state. The same object until something changes.
   */
  getState: () => AudioMemoSessionState
  subscribe(listener: () => void): Unlisten
  /**
   * Idle → start recording (revealing a hidden UI); recording → stop & save.
   */
  toggle(): void
  /**
   * Discard the in-flight recording without saving.
   */
  cancel(): void
  /**
   * Re-run the failed capture.
   */
  retry(): void
  /**
   * Drop the failed memo and let the queue continue.
   */
  discard(): void
  /**
   * The host rendered with the recording UI hidden or shown. While hidden, a
   * live recording stops and saves, and a pending permission request is
   * abandoned — a grant arriving after the UI went away would otherwise start
   * a recording with no UI mounted. The host calls this again whenever
   * {@link AudioMemoSessionState.recorderState} changes.
   */
  setSurfaceHidden(hidden: boolean): void
  /**
   * Release the microphone and stop the transcription lifecycle.
   */
  dispose(): void
}

export interface AudioMemoServiceDeps {
  readonly assetStore: AssetStoreService
  readonly noteFile: NoteFileService
  readonly backlinkTarget: BacklinkTargetService
  readonly transcription: TranscriptionService
  readonly transcriptEnrichment: TranscriptEnrichmentService
  readonly aiProviderConfig: AiProviderConfigService
  readonly aiCredentials: AiCredentialService
  readonly audioRecorder: AudioRecorderService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly activity: ActivityPort
  readonly fileChanges: FileChangeService
  readonly settings: SettingsService
  readonly progress: ProgressPort
  readonly clock: ClockService
  readonly platform: PlatformFacts
  readonly role: GraphRole
  readonly graphSession: GraphSessionSource
  readonly logger: LoggerService
}

/**
 * Audio memos: segmented recordings saved raw under `audio-memos/`,
 * transcribed in the background with a BYOK model, and linked from the daily
 * note. See `AudioMemoTranscriptionService` for the transcription contract.
 */
export interface AudioMemoService {
  /**
   * Open the capture queue and, in the main window, the transcription
   * lifecycle of the open graph's session; throws when no graph is open.
   * Everything the pipeline writes is pinned to that session. Two lifecycles
   * would double-transcribe
   * (and double-bill) the same memos, so a note window gets the queue only:
   * its saved memo is transcribed by the main window, which sees it arrive on
   * the watcher stream.
   */
  openPipeline(options: AudioMemoPipelineOptions): AudioMemoPipeline
  /**
   * Open the desktop recording surface of the open graph's session; throws when no graph is open.
   */
  openSession(options: AudioMemoSessionOptions): AudioMemoSession
}

const NO_PROVIDER_REASON = 'Add an OpenAI or Gemini model in Settings to record audio memos'
const UNSUPPORTED_REASON = 'Audio recording is not supported on this platform'

/**
 * A live session's bookkeeping: identity once known, and cancel cleanup.
 */
interface LiveSession {
  recordedAt: Date
  memo: AudioMemoIdentity | null
  cancelled: boolean
  /**
   * Segment paths already durably written, in case of a later cancel.
   */
  captured: string[]
}

/**
 * The settings path differs per OS.
 */
function micDeniedMessage(platform: PlatformFacts): string {
  return platform.isMacosDesktop
    ? 'Microphone access was denied. Allow it in System Settings → Privacy & Security → Microphone.'
    : 'Microphone access was denied. Allow microphone access for Reflect in your system settings.'
}

interface AudioMemoPipelineDeps {
  readonly aiProviderConfig: AiProviderConfigService
  readonly progress: ProgressPort
  readonly logger: LoggerService
  readonly noteFile: NoteFileService
  readonly assetStore: AssetStoreService
  /**
   * The transcription lifecycle of the open graph's session, or `null` outside the main window.
   */
  readonly reconciler: AudioMemoTranscriptionSession | null
  readonly capturePartAt: (
    input: CaptureAudioMemoPartInput,
    generation: number,
  ) => Promise<CaptureAudioMemoOutcome>
}

class AudioMemoPipelineImpl implements AudioMemoPipeline {
  readonly #deps: AudioMemoPipelineDeps
  readonly #generation: number
  readonly #isErrorSurfaceVisible: () => boolean
  readonly #listeners = new Set<() => void>()
  #pendingCount = 0
  #error: string | null = null
  /**
   * Committed recordings waiting their turn; the pump owns the head.
   */
  readonly #queue: PendingAudioCapture[] = []
  /**
   * Single-drainer guard: one pump loop at a time, one capture at a time.
   */
  #pumping = false
  /**
   * The failed capture a retry should re-run. While parked, the queue holds,
   * memo order in the graph must survive the failure. Taken synchronously:
   * a rapid double Retry must see the first click's take, or two pipelines
   * write the recording twice.
   */
  #parked: PendingAudioCapture | null = null
  #hasTranscriptionConfig: boolean
  #reconciler: AudioMemoTranscriptionSession | null
  #state: AudioMemoPipelineState
  readonly #stopTranscribing: Unlisten | undefined
  readonly #stopConfig: Unlisten

  constructor(deps: AudioMemoPipelineDeps, generation: number, options: AudioMemoPipelineOptions) {
    const { aiProviderConfig } = deps
    this.#deps = deps
    this.#generation = generation
    this.#isErrorSurfaceVisible = options.isErrorSurfaceVisible
    this.#hasTranscriptionConfig = aiProviderConfig.transcriptionConfig() !== null
    // One lifecycle per graph session. It owns the launch pass and all retry
    // triggers; the pump only schedules. Main window only.
    this.#reconciler = deps.reconciler
    this.#state = this.#snapshot()

    this.#stopTranscribing = this.#reconciler?.subscribe(() => {
      this.#publish()
    })
    this.#reconciler?.start()

    // Passes gate on a configured model before any IO. When the user adds the
    // first key mid-session, kick the pass that gate was suppressing.
    this.#stopConfig = aiProviderConfig.subscribe(() => {
      const hadConfig = this.#hasTranscriptionConfig
      this.#hasTranscriptionConfig = aiProviderConfig.transcriptionConfig() !== null
      if (this.#hasTranscriptionConfig && !hadConfig) {
        this.#reconciler?.schedule()
      }
      this.#publish()
    })
  }

  getState(): AudioMemoPipelineState {
    return this.#state
  }

  subscribe(listener: () => void): Unlisten {
    const entry = (): void => {
      listener()
    }
    this.#listeners.add(entry)
    return () => {
      this.#listeners.delete(entry)
    }
  }

  enqueue(capture: PendingAudioCapture): void {
    this.#queue.push(capture)
    this.#pendingCount += 1
    this.#publish()
    void this.#pump()
  }

  reportError(message: string): void {
    this.#error = message
    this.#publish()
  }

  retry(): void {
    const failed = this.#parked
    if (failed === null) {
      return
    }
    this.#parked = null
    this.#error = null
    this.#queue.unshift(failed)
    this.#pendingCount += 1
    this.#publish()
    void this.#pump()
  }

  discard(): void {
    const failed = this.#parked
    this.#parked = null
    this.#error = null
    this.#publish()
    if (failed !== null) {
      void (async () => {
        try {
          await failed.onDiscarded?.()
        } catch (cause) {
          this.#deps.logger.error('audio memo discard cleanup failed:', cause)
        }
      })()
    }
    void this.#pump()
  }

  async listSegments(memo: AudioMemoIdentity): Promise<string[]> {
    const files = await this.#deps.noteFile.listDir(AUDIO_MEMOS_DIR, this.#generation)
    return files
      .filter((file) => audioMemoPartFromPath(file.path)?.memo.base === memo.base)
      .map((file) => file.path)
  }

  async deleteSegment(path: string): Promise<void> {
    await this.#deps.assetStore.deleteAudioMemo(path, this.#generation)
  }

  dispose(): void {
    this.#stopConfig()
    this.#stopTranscribing?.()
    this.#reconciler?.dispose()
    this.#reconciler = null
  }

  #snapshot(): AudioMemoPipelineState {
    return {
      pendingCount: this.#pendingCount,
      transcribing: this.#reconciler?.getTranscribing() ?? false,
      hasTranscriptionConfig: this.#hasTranscriptionConfig,
      error: this.#error,
      canRetry: this.#parked !== null,
    }
  }

  #publish(): void {
    const state = this.#state
    const next = this.#snapshot()
    if (
      next.pendingCount === state.pendingCount &&
      next.transcribing === state.transcribing &&
      next.hasTranscriptionConfig === state.hasTranscriptionConfig &&
      next.error === state.error &&
      next.canRetry === state.canRetry
    ) {
      return
    }
    this.#state = next
    for (const listener of this.#listeners) {
      listener()
    }
  }

  async #pump(): Promise<void> {
    const { logger, progress, capturePartAt } = this.#deps
    if (this.#pumping) {
      return
    }
    this.#pumping = true
    let captured = false
    try {
      while (this.#parked === null) {
        const capture = this.#queue.shift()
        if (capture === undefined) {
          break
        }
        let outcome: CaptureAudioMemoOutcome
        try {
          outcome = await capturePartAt(
            {
              audio: capture.audio,
              mimeType: capture.mimeType,
              recordedAt: capture.recordedAt,
              part: capture.segment.part,
              end: capture.segment.end,
            },
            this.#generation,
          )
        } catch (cause) {
          outcome = { ok: false, message: errorMessage(cause) }
        } finally {
          this.#pendingCount -= 1
          this.#publish()
        }
        if (outcome.ok) {
          captured = true
          try {
            await capture.onCaptured?.()
          } catch (cause) {
            // The audio is already durable in the graph, a cleanup failure
            // must not park the queue behind it.
            logger.error('audio memo post-capture cleanup failed:', cause)
          }
        } else {
          // Park the queue behind the failure: the capture is the one step
          // that can lose audio, and memo order in the graph must survive.
          this.#parked = capture
          this.#error = outcome.message
          this.#publish()
          if (!this.#isErrorSurfaceVisible()) {
            // The error UI is off screen, the failure must still surface
            // somewhere.
            progress.fail('Saving audio memo', outcome.message)
          }
        }
      }
    } finally {
      this.#pumping = false
    }
    if (captured) {
      // The watcher (or mobile's in-process write echo) reports the recording
      // write, which feeds the sync engine's commit debounce like any note
      // edit. Transcription is kicked directly rather than waiting on the
      // watcher's own debounce to echo our write back.
      this.#reconciler?.schedule()
    }
  }
}

interface AudioMemoSessionDeps {
  readonly audioRecorder: AudioRecorderService
  readonly clock: ClockService
  readonly platform: PlatformFacts
  readonly openPipeline: (options: AudioMemoPipelineOptions) => AudioMemoPipeline
}

class AudioMemoSessionImpl implements AudioMemoSession {
  readonly #deps: AudioMemoSessionDeps
  readonly #surface: AudioMemoSurface
  readonly #pipeline: AudioMemoPipeline
  readonly #listeners = new Set<() => void>()
  readonly #unlisten: Unlisten[]
  #surfaceHidden: boolean
  /**
   * True from the stop click until the recorder hands over the blob.
   */
  #stopping = false
  #elapsedMs = 0
  #live: LiveSession | null = null
  /**
   * Re-entry guard for the stop click's await gap.
   */
  #stopGuard = false
  /**
   * The in-flight stop, so a mic click in the gap can chain the next memo.
   */
  #stopSettled: Promise<void> = Promise.resolve()
  /**
   * Concurrent recorder stops share one result, so the final segment is handed over once.
   */
  #recorderStop: Promise<void> | null = null
  #state: AudioMemoSessionState

  constructor(deps: AudioMemoSessionDeps, options: AudioMemoSessionOptions) {
    const { audioRecorder } = deps
    this.#deps = deps
    this.#surface = options.surface
    this.#surfaceHidden = options.surfaceHidden
    // The mic button (and its popover) unmount with the sidebar, so while
    // hidden, a capture failure must surface as an operation instead.
    this.#pipeline = deps.openPipeline({
      isErrorSurfaceVisible: () => !this.#surfaceHidden,
    })
    this.#state = this.#snapshot()

    this.#unlisten = [
      this.#pipeline.subscribe(() => {
        this.#publish()
      }),
      audioRecorder.subscribeState((next) => {
        if (next !== 'recording') {
          this.#elapsedMs = 0
        }
        this.#publish()
      }),
      audioRecorder.subscribeLevel((event) => {
        this.#elapsedMs = event.elapsedMs
        this.#publish()
      }),
      audioRecorder.subscribeSegment((segment) => {
        this.#handleSegment(segment)
      }),
      audioRecorder.subscribeReminder((elapsed) => {
        this.#surface.showReminder(elapsed, () => void this.#stopAndSave())
      }),
    ]
  }

  readonly getState = (): AudioMemoSessionState => this.#state

  subscribe(listener: () => void): Unlisten {
    const entry = (): void => {
      listener()
    }
    this.#listeners.add(entry)
    return () => {
      this.#listeners.delete(entry)
    }
  }

  toggle(): void {
    const recorderState = this.#deps.audioRecorder.state()
    if (recorderState === 'recording') {
      if (this.#stopGuard) {
        // The click landed in the stop's await gap, where the button already
        // reads as the idle mic. Honor it as "record the next memo" once
        // the recorder frees, instead of swallowing it on the re-entry guard.
        void this.#stopSettled.then(() => this.#start())
      } else {
        void this.#stopAndSave()
      }
    } else if (recorderState === 'requesting') {
      // A second press while the OS prompt is up aborts the request. The
      // alternative is a click that visibly does nothing.
      this.#cancelRecorder()
    } else if (this.#pipeline.getState().error !== null) {
      // A parked error must never invisibly block recording. Hidden, the
      // error UI doesn't exist, so surface it; visible, it was on screen and a
      // fresh record request acknowledges it (the same click the red mic
      // anchor handles).
      if (this.#surfaceHidden) {
        this.#surface.reveal()
      } else {
        this.#pipeline.discard()
      }
    } else {
      void this.#start()
    }
  }

  cancel(): void {
    this.#surface.dismissReminder()
    const session = this.#live
    if (session !== null) {
      // Discard means discard: segments already on disk go too. Segments
      // whose write is still in flight delete themselves via onCaptured.
      session.cancelled = true
      for (const path of session.captured) {
        void this.#pipeline.deleteSegment(path).catch(() => {})
      }
      session.captured = []
    }
    this.#cancelRecorder()
  }

  retry(): void {
    this.#pipeline.retry()
  }

  discard(): void {
    this.#pipeline.discard()
  }

  setSurfaceHidden(hidden: boolean): void {
    this.#surfaceHidden = hidden
    if (!hidden) {
      return
    }
    const recorderState = this.#deps.audioRecorder.state()
    if (recorderState === 'recording') {
      void this.#stopAndSave()
    } else if (recorderState === 'requesting') {
      this.#cancelRecorder()
    }
  }

  dispose(): void {
    for (const stop of this.#unlisten) {
      stop()
    }
    // Never leave the mic open past the session.
    this.#cancelRecorder()
    this.#pipeline.dispose()
  }

  #snapshot(): AudioMemoSessionState {
    const { audioRecorder } = this.#deps
    const recorderState = audioRecorder.state()
    const pipelineState = this.#pipeline.getState()
    const unavailableReason = !audioRecorder.isSupported()
      ? UNSUPPORTED_REASON
      : !pipelineState.hasTranscriptionConfig
        ? NO_PROVIDER_REASON
        : null
    return {
      // A live capture owns the surface. A background save's failure parks and
      // shows after the stop, never yanking the waveform mid-recording.
      phase:
        recorderState === 'recording' && !this.#stopping
          ? 'recording'
          : recorderState === 'requesting'
            ? 'requesting'
            : pipelineState.error !== null
              ? 'error'
              : this.#stopping || pipelineState.pendingCount > 0 || pipelineState.transcribing
                ? 'transcribing'
                : 'idle',
      elapsedMs: this.#elapsedMs,
      stream: audioRecorder.stream(),
      pendingCount: pipelineState.pendingCount,
      available: unavailableReason === null,
      unavailableReason,
      error: pipelineState.error,
      canRetry: pipelineState.canRetry,
      recorderState,
    }
  }

  #publish(): void {
    const state = this.#state
    const next = this.#snapshot()
    if (
      next.phase === state.phase &&
      next.elapsedMs === state.elapsedMs &&
      next.stream === state.stream &&
      next.pendingCount === state.pendingCount &&
      next.unavailableReason === state.unavailableReason &&
      next.error === state.error &&
      next.canRetry === state.canRetry &&
      next.recorderState === state.recorderState
    ) {
      return
    }
    this.#state = next
    for (const listener of this.#listeners) {
      listener()
    }
  }

  #handleSegment(segment: AudioRecorderSegment): void {
    if (segment.audio.kind !== 'blob') {
      throw new Error('the webview audio recorder produced a staged segment')
    }
    const pipeline = this.#pipeline
    const session = this.#live
    if (session === null || session.cancelled) {
      return
    }
    session.memo ??= audioMemoIdentity(session.recordedAt, segment.mimeType)
    const path = audioMemoPartPath(session.memo, segment.part, segment.end)
    pipeline.enqueue({
      audio: segment.audio,
      mimeType: segment.mimeType,
      recordedAt: session.recordedAt,
      segment: { part: segment.part, end: segment.end },
      onCaptured: () => {
        // A cancel may land while this segment's write is in flight. Its
        // bytes are durable by now, so the cancel cleanup runs here.
        if (session.cancelled) {
          return pipeline.deleteSegment(path).catch(() => {})
        }
        session.captured.push(path)
      },
    })
  }

  /**
   * Stop the recorder and hand over the final segment; `null` for a misclick.
   */
  #stopRecorder(): Promise<void> {
    this.#recorderStop ??= (async (): Promise<void> => {
      const final = await this.#deps.audioRecorder.stop()
      if (final !== null) {
        this.#handleSegment(final)
      }
    })().finally(() => {
      this.#recorderStop = null
    })
    return this.#recorderStop
  }

  #cancelRecorder(): void {
    void this.#deps.audioRecorder.cancel()
  }

  async #start(): Promise<void> {
    const { audioRecorder, clock, platform } = this.#deps
    if (!audioRecorder.isSupported() || !this.#pipeline.getState().hasTranscriptionConfig) {
      return
    }
    if (this.#surfaceHidden) {
      // Never record without visible recording UI.
      this.#surface.reveal()
    }
    try {
      await audioRecorder.start({
        segmentMs: AUDIO_MEMO_SEGMENT_MS,
        reminderMs: AUDIO_MEMO_REMINDER_MS,
      })
      // Identity derives from the session's start. Every segment shares it.
      this.#live = { recordedAt: new Date(clock.now()), memo: null, cancelled: false, captured: [] }
    } catch (cause) {
      this.#pipeline.reportError(
        cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? micDeniedMessage(platform)
          : errorMessage(cause),
      )
    }
  }

  #stopAndSave(): Promise<void> {
    if (this.#stopGuard) {
      return Promise.resolve()
    }
    this.#stopGuard = true
    this.#surface.dismissReminder()
    // The stop click commits the memo: flip to 'transcribing' before the stop
    // settles, so an Esc landing in the await gap can't read a lingering
    // 'recording' phase and cancel a recording the user just saved.
    this.#stopping = true
    this.#publish()
    const settled = (async (): Promise<void> => {
      try {
        // Segments (including the final one) flow through the segment
        // handler as the recorder rotates; the stop only flushes.
        await this.#stopRecorder()
      } finally {
        this.#stopGuard = false
        this.#stopping = false
        this.#publish()
      }
    })()
    this.#stopSettled = settled
    return settled
  }
}

class AudioMemoServiceImpl implements AudioMemoService {
  readonly #deps: AudioMemoServiceDeps
  readonly #transcriptions: AudioMemoTranscriptionService
  readonly #mainWindow: boolean

  constructor(deps: AudioMemoServiceDeps) {
    this.#deps = deps
    this.#mainWindow = deps.role === 'main'
    this.#transcriptions = createAudioMemoTranscriptionService({
      noteFile: deps.noteFile,
      assetStore: deps.assetStore,
      backlinkTarget: deps.backlinkTarget,
      transcription: deps.transcription,
      transcriptEnrichment: deps.transcriptEnrichment,
      aiProviderConfig: deps.aiProviderConfig,
      aiCredentials: deps.aiCredentials,
      settings: deps.settings,
      reconcilers: deps.reconcilers,
      activity: deps.activity,
      fileChanges: deps.fileChanges,
      progress: deps.progress,
      clock: deps.clock,
    })
  }

  openPipeline(options: AudioMemoPipelineOptions): AudioMemoPipeline {
    const { aiProviderConfig, progress, logger, noteFile, assetStore, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    return new AudioMemoPipelineImpl(
      {
        aiProviderConfig,
        progress,
        logger,
        noteFile,
        assetStore,
        // One lifecycle per graph session, main window only.
        reconciler: this.#mainWindow ? this.#transcriptions.openSession({ generation }) : null,
        capturePartAt: (input, at) => this.#capturePartAt(input, at),
      },
      generation,
      options,
    )
  }

  openSession(options: AudioMemoSessionOptions): AudioMemoSession {
    const { audioRecorder, clock, platform } = this.#deps
    return new AudioMemoSessionImpl(
      {
        audioRecorder,
        clock,
        platform,
        openPipeline: (pipelineOptions) => this.openPipeline(pipelineOptions),
      },
      options,
    )
  }

  /**
   * Persist one recording into the graph, the durable step, no network.
   */
  async #writeAudioMemoAsset(
    path: string,
    audio: RecordedAudio,
    generation: number,
  ): Promise<void> {
    const { assetStore } = this.#deps
    if (audio.kind === 'staged') {
      // The recorder already wrote the file: Rust copies it in file-to-file, so
      // a meeting-length segment never enters webview memory.
      await assetStore.importAudioMemo(audio.path, path, generation)
      return
    }
    // Streamed where the transport carries binary bodies. Browser dev's
    // in-memory bridge has none; recordings there are short enough for the
    // base64 JSON route.
    await assetStore.uploadToPath(path, audio.blob, generation)
  }

  async #capturePartAt(
    input: CaptureAudioMemoPartInput,
    generation: number,
  ): Promise<CaptureAudioMemoOutcome> {
    const memo = audioMemoIdentity(input.recordedAt, input.mimeType)
    try {
      await this.#writeAudioMemoAsset(
        audioMemoPartPath(memo, input.part, input.end),
        input.audio,
        generation,
      )
    } catch (cause) {
      return { ok: false, message: errorMessage(cause) }
    }
    return { ok: true, memo }
  }
}

export function createAudioMemoService(deps: AudioMemoServiceDeps): AudioMemoService {
  return new AudioMemoServiceImpl(deps)
}
