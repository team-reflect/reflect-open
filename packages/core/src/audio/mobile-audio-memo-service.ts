import type { MaybePromise } from '@reflect/utils'
import { AUDIO_MEMO_REMINDER_MS, AUDIO_MEMO_SEGMENT_MS } from './audio-memo-session.ts'
import { audioMemoIdentity, audioMemoPartPath } from './audio-memo.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import { errorMessage } from '../errors.ts'
import type { Unlisten } from '../unlisten.ts'
import type { HapticsService } from '../ipc/haptics-service.ts'
import type { AudioMemoPhase, AudioMemoService } from './audio-memo-service.ts'
import type {
  AudioRecorderSegment,
  AudioRecorderService,
  AudioRecorderState,
} from './audio-recorder-service.ts'
import { NATIVE_RECORDING_MIME } from './native-audio-recorder.ts'
import type { NativeActionService } from './native-action-service.ts'

const MIC_DENIED_REASON = 'Microphone access was denied. Allow it for Reflect in the Settings app.'

/**
 * What a {@link MobileAudioMemoSession} shows of itself.
 */
export interface MobileAudioMemoSessionState {
  readonly phase: AudioMemoPhase
  /**
   * Live while recording.
   */
  readonly elapsedMs: number
  /**
   * Latest input level 0…1, for the waveform.
   */
  readonly level: number
  /**
   * Recordings committed but not yet written to the graph.
   */
  readonly pendingCount: number
  /**
   * False without the native shell (the recorder is a native plugin).
   */
  readonly available: boolean
  /**
   * False when no OpenAI/Gemini model is configured; the drawer then guides key setup.
   */
  readonly hasTranscriptionConfig: boolean
  /**
   * The failure shown in the error phase.
   */
  readonly error: string | null
  /**
   * True when a retry can re-run the failed capture.
   */
  readonly canRetry: boolean
  /**
   * The recording drawer's visibility.
   */
  readonly drawerOpen: boolean
}

export interface MobileAudioMemoServiceDeps {
  readonly audioMemo: AudioMemoService
  readonly audioRecorder: AudioRecorderService
  readonly nativeAction: NativeActionService
  readonly activity: ActivityPort
  readonly haptics: HapticsService
  readonly platform: PlatformFacts
  readonly logger: LoggerService
}

/**
 * The mobile audio-memo surface for one graph session: the native recorder
 * plugin over the shared capture pipeline (`AudioMemoService.openPipeline` —
 * the same serial queue and transcription lifecycle desktop uses). Desktop
 * presents recording in a sidebar popover; here it is a bottom drawer plus
 * the mic action in the Daily capture menu.
 *
 * Mobile-only responsibilities:
 *
 * - **Segments and native stops.** The recorder rotates itself every
 *   `AUDIO_MEMO_SEGMENT_MS`, announcing each finished segment; interruptions
 *   (calls, Siri) and input-route loss end the session natively. Both are
 *   ingested exactly like a user stop. A session has no duration limit, and
 *   backgrounding is deliberately not a stop: `UIBackgroundModes: audio`
 *   keeps a memo capturing through screen lock (V1 parity).
 * - **The orphan scan**: staged segments no live flow owns — from a crash, a
 *   webview reload, or a kill while backgrounded — are handed to the capture
 *   pipeline when the session opens and on every foreground, oldest session
 *   first. Finished segments of the session recording *right now* are picked
 *   up too: they are complete files (the listing excludes the one still
 *   being written), and landing them early is the point. Ingest is
 *   idempotent by session and position, so a file whose delete failed
 *   re-resolves to the same segment on the next scan instead of duplicating.
 * - **The live-recording reconcile + native-action handshake**
 *   (`NativeActionService`): a recording that outlived its JS is stopped and
 *   saved rather than left a hidden hot microphone, and OS entry points'
 *   queued `recordAudio` requests are claimed and confirmed.
 */
export interface MobileAudioMemoSession {
  /**
   * The current state. The same object until something changes.
   */
  getState: () => MobileAudioMemoSessionState
  subscribe(listener: () => void): Unlisten
  /**
   * Audio action tap: idle → record (or key setup); recording → stop & save; error → show it.
   */
  toggle(): void
  /**
   * The drawer's stop control — commit the memo.
   */
  stopAndSave(): void
  /**
   * The drawer's discard control — drop the live recording.
   */
  cancelRecording(): MaybePromise<void>
  /**
   * Drawer dismissal: a live recording stops-and-saves, never silently drops.
   */
  setDrawerOpen(open: boolean): void
  /**
   * Re-run the failed capture.
   */
  retry(): void
  /**
   * Drop the failed memo and let the queue continue.
   */
  discard(): void
  /**
   * Detach from the recorder and stop the transcription lifecycle. A live recording keeps running.
   */
  dispose(): void
}

/**
 * Native recording sessions end to end: start, stop-and-save, discard, and exactly-once ingest.
 */
export interface MobileAudioMemoService {
  /**
   * Open the mobile recording surface of the open graph's session; throws when no graph is open.
   */
  openSession(): MobileAudioMemoSession
}

/**
 * One finished segment of a recording session, staged and ready to ingest.
 */
interface StagedPart {
  /**
   * The staged file's absolute path; deleted once the graph write lands.
   */
  stagedPath: string
  /**
   * The session's start time, used as the memo's identity timestamp. Every
   * segment of one session shares it, and it is encoded in the staged
   * filename — so the live flow and the orphan scan file the same segment
   * under the same memo basename.
   */
  recordedAt: Date
  /**
   * 1-based position within the session.
   */
  part: number
  /**
   * True on the session's final segment (its file carries `-end`).
   */
  end: boolean
}

/**
 * The live recording session. The graph is its ledger, so this only carries
 * identity: unlike desktop, a session here can outlive the webview that
 * started it, and an in-memory list of captured paths would miss whatever a
 * previous webview ingested for the same recording.
 */
interface LiveSession {
  /**
   * Identity derives from the session's start: every segment shares it.
   */
  recordedAt: Date
  cancelled: boolean
}

function toStagedPart(segment: AudioRecorderSegment): StagedPart {
  if (segment.audio.kind !== 'staged') {
    throw new Error('the native audio recorder produced an unstaged segment')
  }
  return {
    stagedPath: segment.audio.path,
    recordedAt: new Date(segment.sessionStartedMs),
    part: segment.part,
    end: segment.end,
  }
}

/**
 * True when the native recorder rejected `start` because access was denied.
 */
function isMicDeniedError(cause: unknown): boolean {
  return errorMessage(cause).includes('denied')
}

class MobileAudioMemoSessionImpl implements MobileAudioMemoSession {
  readonly #deps: MobileAudioMemoServiceDeps
  readonly #listeners = new Set<() => void>()
  readonly #pipeline: ReturnType<AudioMemoService['openPipeline']>
  readonly #available: boolean
  readonly #unlisten: Unlisten[]
  #drawerOpen = false
  /**
   * True from the stop tap until the recorder hands over the file.
   */
  #stopping = false
  #elapsedMs = 0
  #level = 0
  #live: LiveSession | null = null
  /**
   * Sessions the user discarded, by identity timestamp. A native discard that
   * fails to delete a staged segment leaves it for the orphan scan, which
   * would otherwise resurrect a memo the user threw away on the next
   * foreground.
   */
  readonly #cancelledSessions = new Set<number>()
  /**
   * Re-entry guard for the stop tap's await gap.
   */
  #stopGuard = false
  /**
   * One orphan scan at a time.
   */
  #scanning = false
  #disposed = false
  #state: MobileAudioMemoSessionState

  constructor(deps: MobileAudioMemoServiceDeps) {
    const { audioMemo, audioRecorder, nativeAction, activity, platform } = deps
    this.#deps = deps
    // The pump consults the drawer the instant a capture fails.
    this.#pipeline = audioMemo.openPipeline({
      isErrorSurfaceVisible: () => this.#drawerOpen,
    })
    this.#available = platform.isNativeShell
    this.#state = this.#snapshot()

    this.#unlisten = [
      this.#pipeline.subscribe(() => {
        this.#publish()
      }),
      audioRecorder.subscribeState((next) => {
        if (next !== 'recording') {
          this.#elapsedMs = 0
          this.#level = 0
        }
        this.#publish()
      }),
      audioRecorder.subscribeLevel((event) => {
        this.#level = event.level
        this.#elapsedMs = event.elapsedMs
        this.#publish()
      }),
      // A segment the recorder rotated away from; the session keeps recording.
      audioRecorder.subscribeSegment((segment) => {
        this.#enqueuePart(toStagedPart(segment))
      }),
      // A stop the native side initiated (interruption, route change): the file
      // is already staged and end-marked, treated exactly like a user stop.
      audioRecorder.subscribeStopped((stopped) => {
        this.#setDrawerOpen(false)
        this.#setStopping(false)
        if (stopped.segment !== null) {
          this.#enqueuePart(toStagedPart(stopped.segment))
        }
        this.#live = null
      }),
      nativeAction.open({
        start: () => this.#start(),
        onReconciledSegment: (segment) => {
          this.#enqueuePart(toStagedPart(segment))
        },
      }),
    ]
    if (platform.isNativeShell) {
      void this.#scan()
      this.#unlisten.push(activity.subscribeVisible(() => void this.#scan()))
    }
  }

  readonly getState = (): MobileAudioMemoSessionState => this.#state

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
    const { audioRecorder } = this.#deps
    const recorderState = audioRecorder.state()
    if (recorderState === 'recording') {
      void this.#stopAndSave()
    } else if (recorderState === 'requesting') {
      void this.#cancelRecorder()
      this.#setDrawerOpen(false)
    } else if (this.#pipeline.getState().error !== null) {
      // A parked error must never invisibly block recording. The audio
      // action reopens the drawer, which shows the failure with Retry/Discard.
      this.#setDrawerOpen(true)
    } else {
      void this.#start()
    }
  }

  stopAndSave(): void {
    void this.#stopAndSave()
  }

  async cancelRecording(): Promise<void> {
    const { audioRecorder, logger } = this.#deps
    this.#setDrawerOpen(false)
    const session = this.#live
    if (session !== null) {
      // Discard means discard: every segment already in the graph goes too.
      // What is on disk is the only complete account of what this session
      // wrote, and the flag catches the segments still being copied.
      session.cancelled = true
      this.#cancelledSessions.add(session.recordedAt.getTime())
      const memo = audioMemoIdentity(session.recordedAt, NATIVE_RECORDING_MIME)
      void (async () => {
        for (const path of await this.#pipeline.listSegments(memo)) {
          await this.#pipeline.deleteSegment(path).catch(() => {})
        }
      })().catch((cause: unknown) => {
        logger.error('discarding the recorded segments failed:', cause)
      })
    }
    try {
      await audioRecorder.cancel()
    } catch (cause: unknown) {
      logger.warn('cancel raced a native finalize:', cause)
    } finally {
      if (this.#live === session) {
        this.#live = null
      }
    }
  }

  setDrawerOpen(open: boolean): void {
    const { audioRecorder } = this.#deps
    if (open) {
      this.#setDrawerOpen(true)
      return
    }
    // Dismissing the drawer mid-recording saves. A swipe-down must never
    // silently drop audio (discarding is the explicit Cancel control).
    const recorderState = audioRecorder.state()
    if (recorderState === 'recording') {
      void this.#stopAndSave()
    } else if (recorderState === 'requesting') {
      void this.#cancelRecorder()
    }
    this.#setDrawerOpen(false)
  }

  retry(): void {
    this.#pipeline.retry()
  }

  discard(): void {
    this.#pipeline.discard()
  }

  dispose(): void {
    this.#disposed = true
    for (const stop of this.#unlisten) {
      stop()
    }
    this.#pipeline.dispose()
  }

  #snapshot(): MobileAudioMemoSessionState {
    const recorderState: AudioRecorderState = this.#deps.audioRecorder.state()
    const pipelineState = this.#pipeline.getState()
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
      level: this.#level,
      pendingCount: pipelineState.pendingCount,
      available: this.#available,
      hasTranscriptionConfig: pipelineState.hasTranscriptionConfig,
      error: pipelineState.error,
      canRetry: pipelineState.canRetry,
      drawerOpen: this.#drawerOpen,
    }
  }

  #publish(): void {
    const state = this.#state
    const next = this.#snapshot()
    if (
      next.phase === state.phase &&
      next.elapsedMs === state.elapsedMs &&
      next.level === state.level &&
      next.pendingCount === state.pendingCount &&
      next.hasTranscriptionConfig === state.hasTranscriptionConfig &&
      next.error === state.error &&
      next.canRetry === state.canRetry &&
      next.drawerOpen === state.drawerOpen
    ) {
      return
    }
    this.#state = next
    for (const listener of this.#listeners) {
      listener()
    }
  }

  #setDrawerOpen(open: boolean): void {
    this.#drawerOpen = open
    this.#publish()
  }

  #setStopping(next: boolean): void {
    this.#stopping = next
    this.#publish()
  }

  #hapticImpactLight(): void {
    void this.#deps.haptics.impactLight().catch(() => {})
  }

  /**
   * Wrap a staged segment as a pipeline capture that owns the file.
   */
  #enqueuePart(part: StagedPart): void {
    const { audioRecorder } = this.#deps
    const pipeline = this.#pipeline
    const release = async (): Promise<void> => {
      // Always drop the claim, even if the delete fails: a still-claimed
      // path is skipped forever by the orphan scan, so a discarded memo
      // whose delete threw would otherwise reappear on the next launch.
      try {
        await audioRecorder.deleteStaged(part.stagedPath)
      } finally {
        audioRecorder.releaseStaged(part.stagedPath)
      }
    }
    if (this.#cancelledSessions.has(part.recordedAt.getTime())) {
      void release()
      return
    }
    const memo = audioMemoIdentity(part.recordedAt, NATIVE_RECORDING_MIME)
    const path = audioMemoPartPath(memo, part.part, part.end)
    // Only the live session's segments answer to its cancel: a segment the
    // orphan scan found from an earlier run must not be swept away by
    // discarding the recording running now.
    const session = this.#live
    const owner =
      session !== null && session.recordedAt.getTime() === part.recordedAt.getTime()
        ? session
        : null
    pipeline.enqueue({
      audio: { kind: 'staged', path: part.stagedPath },
      mimeType: NATIVE_RECORDING_MIME,
      recordedAt: part.recordedAt,
      segment: { part: part.part, end: part.end },
      onCaptured: async () => {
        // A cancel that swept the directory before this segment's copy
        // landed has to be honored here instead.
        if (owner?.cancelled === true) {
          await pipeline.deleteSegment(path).catch(() => {})
        }
        await release()
      },
      onDiscarded: release,
    })
  }

  async #start(): Promise<void> {
    const { audioRecorder } = this.#deps
    if (!this.#available) {
      return
    }
    this.#setDrawerOpen(true)
    // Recording never starts without a transcription key: the drawer opens on
    // its key-setup guidance instead. OS entry points (Siri, the widget, the
    // quick action) funnel through here too, so they surface the same guidance.
    if (!this.#pipeline.getState().hasTranscriptionConfig) {
      return
    }
    try {
      const session = await audioRecorder.start({
        segmentMs: AUDIO_MEMO_SEGMENT_MS,
        reminderMs: AUDIO_MEMO_REMINDER_MS,
      })
      if (session !== null) {
        this.#live = { recordedAt: new Date(session.sessionStartedMs), cancelled: false }
      }
      this.#hapticImpactLight()
    } catch (cause) {
      this.#pipeline.reportError(isMicDeniedError(cause) ? MIC_DENIED_REASON : errorMessage(cause))
    }
  }

  /** Cancels a recording that is still requesting permission; a failure is logged. */
  async #cancelRecorder(): Promise<void> {
    try {
      await this.#deps.audioRecorder.cancel()
    } catch (cause: unknown) {
      this.#deps.logger.warn('cancelling a recording that was still starting failed:', cause)
    }
  }

  /**
   * Stop and hand back the final segment, `null` for a session too short to keep.
   */
  async #stopRecorder(): Promise<StagedPart | null> {
    const { audioRecorder } = this.#deps
    // A stop in flight keeps the state at `recording` until it settles, and
    // the recorder hands every concurrent caller the same result.
    if (audioRecorder.state() !== 'recording') {
      return null
    }
    const final = await audioRecorder.stop()
    return final === null ? null : toStagedPart(final)
  }

  async #stopAndSave(): Promise<void> {
    if (this.#stopGuard) {
      return
    }
    this.#stopGuard = true
    // The stop tap commits the memo: the drawer closes now, and the capture
    // menu's mic action reflects the 'transcribing' state when reopened.
    this.#setStopping(true)
    this.#setDrawerOpen(false)
    try {
      const part = await this.#stopRecorder()
      if (part !== null) {
        this.#enqueuePart(part)
      }
      this.#live = null
      this.#hapticImpactLight()
    } catch (cause) {
      // A native stop (interruption, backgrounding) won the race. Its
      // stopped event delivers the memo instead.
      this.#deps.logger.warn('stop raced a native finalize:', cause)
    } finally {
      this.#stopGuard = false
      this.#setStopping(false)
    }
  }

  /**
   * Hand unclaimed staged segments to the capture pipeline.
   */
  async #scan(): Promise<void> {
    const { audioRecorder, logger } = this.#deps
    if (this.#scanning) {
      return
    }
    this.#scanning = true
    try {
      const files = await audioRecorder.listStaged()
      for (const file of files) {
        if (this.#disposed) {
          return
        }
        if (audioRecorder.isStagedClaimed(file.path)) {
          continue
        }
        audioRecorder.claimStaged(file.path)
        this.#enqueuePart({
          stagedPath: file.path,
          recordedAt: new Date(file.sessionStartedMs),
          part: file.part,
          end: file.end,
        })
      }
    } catch (cause) {
      logger.error('audio memo orphan scan failed:', cause)
    } finally {
      this.#scanning = false
    }
  }
}

class MobileAudioMemoServiceImpl implements MobileAudioMemoService {
  readonly #deps: MobileAudioMemoServiceDeps

  constructor(deps: MobileAudioMemoServiceDeps) {
    this.#deps = deps
  }

  openSession(): MobileAudioMemoSession {
    return new MobileAudioMemoSessionImpl(this.#deps)
  }
}

export function createMobileAudioMemoService(
  deps: MobileAudioMemoServiceDeps,
): MobileAudioMemoService {
  return new MobileAudioMemoServiceImpl(deps)
}
