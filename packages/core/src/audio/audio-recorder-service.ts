import type { MaybePromise } from '@reflect/utils'
import type { Unlisten } from '../unlisten.ts'
import type {
  RecordingLevelEvent,
  RecordingNativeActionEvent,
  RecordingSessionStart,
  RecordingStatus,
  StagedRecordingFile,
  StartRecordingOptions,
} from '../ipc/recording-plugin.ts'

export type {
  RecordingLevelEvent,
  RecordingNativeActionEvent,
  RecordingSessionStart,
  RecordingStatus,
  StagedRecordingFile,
  StartRecordingOptions,
} from '../ipc/recording-plugin.ts'

/**
 * The local recorder state.
 */
export type AudioRecorderState = 'idle' | 'requesting' | 'recording'

/**
 * Where a finished segment's bytes are.
 */
export type RecordedAudio =
  /**
   * A file in the native recorder's staging directory.
   */
  | { kind: 'staged'; path: string }
  /**
   * Bytes the webview recorder holds in memory.
   */
  | { kind: 'blob'; blob: Blob }

/**
 * One finished segment of a recording session.
 */
export interface AudioRecorderSegment {
  audio: RecordedAudio
  /**
   * The container the recorder produced.
   */
  mimeType: string
  /**
   * The session's start; every segment of one session shares it.
   */
  sessionStartedMs: number
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
 * A session's final segment.
 */
export interface AudioRecorderFinalSegment extends AudioRecorderSegment {
  end: true
  /**
   * The whole session's length.
   */
  durationMs: number
}

/**
 * A session the recorder ended by itself (interruption, route change).
 */
export interface AudioRecorderStopped {
  /**
   * The final segment, or `null` when the session was too short to keep.
   */
  segment: AudioRecorderFinalSegment | null
  reason: string
}

/**
 * The microphone recorder behind audio memos. Segments rotate every
 * `segmentMs`; a session ends on {@link stop}, {@link cancel}, or a stop the
 * recorder initiates ({@link subscribeStopped}).
 *
 * Staged files a live flow owns are "claimed": every segment and final
 * segment the recorder hands out is claimed, and an orphan scan over
 * {@link listStaged} skips claimed files so no file is ingested twice.
 */
export interface AudioRecorderService {
  /**
   * True when the host exposes the recording APIs.
   */
  isSupported(): boolean
  state(): AudioRecorderState
  /**
   * Calls `listener` on every {@link state} change.
   */
  subscribeState(listener: (state: AudioRecorderState) => void): Unlisten
  /**
   * The live input stream for a waveform, or `null` when none is exposed.
   */
  stream(): MediaStream | null
  /**
   * Ask for the microphone and start a session. Resolves the session's
   * identity, or `null` when a session is already live or the start was
   * cancelled. Rejects when access is denied.
   */
  start(options: StartRecordingOptions): Promise<RecordingSessionStart | null>
  /**
   * Stop the session and claim its final segment; `null` for a session too
   * short to keep. Concurrent calls share one result.
   */
  stop(): Promise<AudioRecorderFinalSegment | null>
  /**
   * Stop and discard the session.
   */
  cancel(): MaybePromise<void>
  /**
   * Whether a session is live in the recorder itself, which can outlive the webview.
   */
  status(): MaybePromise<RecordingStatus>
  /**
   * Finished recordings still in staging.
   */
  listStaged(): MaybePromise<StagedRecordingFile[]>
  /**
   * Remove a staged recording once its bytes are durable.
   */
  deleteStaged(path: string): MaybePromise<void>
  claimStaged(path: string): void
  releaseStaged(path: string): void
  isStagedClaimed(path: string): boolean
  /**
   * The action surface is mounted: deliver any queued native action. An
   * aborted `signal` skips the handshake.
   */
  actionsReady(options?: { signal?: AbortSignal }): MaybePromise<void>
  /**
   * Retire the delivered native action so it does not fire again on the next launch.
   */
  actionPerformed(): MaybePromise<void>
  /**
   * Input level and elapsed time while recording.
   */
  subscribeLevel(listener: (event: RecordingLevelEvent) => void): Unlisten
  /**
   * A rotated, non-final segment; the session keeps recording.
   */
  subscribeSegment(listener: (segment: AudioRecorderSegment) => void): Unlisten
  subscribeStopped(listener: (stopped: AudioRecorderStopped) => void): Unlisten
  /**
   * The session crossed another `reminderMs` boundary, with its elapsed time.
   */
  subscribeReminder(listener: (elapsedMs: number) => void): Unlisten
  /**
   * An OS entry point (Siri, a quick action, a widget) asked for an action.
   */
  subscribeNativeAction(listener: (event: RecordingNativeActionEvent) => void): Unlisten
}

/**
 * Below this a one-segment recording is a misclick, not a memo.
 */
export const MIN_RECORDING_DURATION_MS = 500
