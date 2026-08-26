import { z } from 'zod'
import { definePluginCommand, definePluginEvent, ignoredResult } from './plugin'

/**
 * Typed bindings for `plugins/tauri-plugin-recording` — the native audio-memo
 * recorder (the desktop half currently rejects every command with
 * `UnsupportedPlatform`, see the plugin's `desktop.rs`). Each schema and
 * args type mirrors a serde model in the plugin's `src/models.rs` (commands)
 * or an `Encodable` struct in `ios/Sources/RecordingPlugin.swift` (events);
 * a field change there must land here in the same review.
 */

/** Mirrors `StartResponse`: the identity every segment of a session shares. */
const startResponseSchema = z.object({ sessionStartedMs: z.number() })
export type RecordingSessionStart = z.infer<typeof startResponseSchema>

/** Mirrors `StopResponse`: a session's final segment, still in staging. */
const stopResponseSchema = z.object({
  path: z.string(),
  sessionStartedMs: z.number(),
  part: z.number(),
  durationMs: z.number(),
})
export type RecordingStopResponse = z.infer<typeof stopResponseSchema>

/** Mirrors `RecordingStatusResponse`. */
const recordingStatusSchema = z.object({ recording: z.boolean(), elapsedMs: z.number() })
export type RecordingStatus = z.infer<typeof recordingStatusSchema>

/** Mirrors `StagedFile` (one entry of `ListStagedResponse`). */
const stagedFileSchema = z.object({
  path: z.string(),
  sessionStartedMs: z.number(),
  part: z.number(),
  end: z.boolean(),
  modifiedMs: z.number(),
})
export type StagedRecordingFile = z.infer<typeof stagedFileSchema>

const listStagedSchema = z.object({ files: z.array(stagedFileSchema) })

// Command args mirror the serde request models (`StartRequest`,
// `StagedPathRequest`) under the command's `request` parameter.
const startRecordingCommand = definePluginCommand<
  { request: StartRecordingOptions },
  RecordingSessionStart
>('recording', 'start_recording', startResponseSchema)
const stopRecordingCommand = definePluginCommand<Record<string, never>, RecordingStopResponse>(
  'recording',
  'stop_recording',
  stopResponseSchema,
)
const cancelRecordingCommand = definePluginCommand<Record<string, never>, unknown>(
  'recording',
  'cancel_recording',
  ignoredResult,
)
const recordingStatusCommand = definePluginCommand<Record<string, never>, RecordingStatus>(
  'recording',
  'recording_status',
  recordingStatusSchema,
)
const actionsReadyCommand = definePluginCommand<Record<string, never>, unknown>(
  'recording',
  'actions_ready',
  ignoredResult,
)
const actionPerformedCommand = definePluginCommand<Record<string, never>, unknown>(
  'recording',
  'action_performed',
  ignoredResult,
)
const listStagedCommand = definePluginCommand<
  Record<string, never>,
  { files: StagedRecordingFile[] }
>('recording', 'list_staged', listStagedSchema)
const deleteStagedCommand = definePluginCommand<{ request: { path: string } }, unknown>(
  'recording',
  'delete_staged',
  ignoredResult,
)

export interface StartRecordingOptions {
  /**
   * Rotate the recorder after this much audio, natively, so rotation holds
   * even if JS never wakes. Each segment is one staged file.
   */
  segmentMs: number
  /**
   * Remind the user this often while the session runs. The plugin schedules
   * the notification itself, so it survives a sleeping webview and is
   * cleared by whatever ends the session.
   */
  reminderMs: number
}

/** Ask for the microphone and start a recording session. */
export async function startRecording(
  options: StartRecordingOptions,
): Promise<RecordingSessionStart> {
  return await startRecordingCommand({ request: options })
}

/** Stop the active recording; rejects when nothing is recording. */
export async function stopRecording(): Promise<RecordingStopResponse> {
  return await stopRecordingCommand({})
}

/** Stop the active recording and discard its file. */
export async function cancelRecording(): Promise<void> {
  await cancelRecordingCommand({})
}

/** Whether a native recording is live right now (webview-reload reconcile). */
export async function recordingStatus(): Promise<RecordingStatus> {
  return await recordingStatusCommand({})
}

/** The webview's action surface is mounted — deliver any queued native action. */
export async function actionsReady(): Promise<void> {
  await actionsReadyCommand({})
}

/** Retire the delivered native action so it doesn't re-fire on next launch. */
export async function actionPerformed(): Promise<void> {
  await actionPerformedCommand({})
}

/** Finished recordings still in staging (crash orphans, files mid-ingest). */
export async function listStaged(): Promise<StagedRecordingFile[]> {
  const { files } = await listStagedCommand({})
  return files
}

/** Remove a staged recording once its bytes are durable in the graph. */
export async function deleteStaged(path: string): Promise<void> {
  await deleteStagedCommand({ request: { path } })
}

/** Mirrors Swift `RecordingLevel` (~10 Hz while recording, foreground only). */
const levelEventSchema = z.object({ level: z.number(), elapsedMs: z.number() })
export type RecordingLevelEvent = z.infer<typeof levelEventSchema>

/** Mirrors Swift `RecordingSegment` (a finished, non-final segment). */
const segmentEventSchema = z.object({
  path: z.string(),
  sessionStartedMs: z.number(),
  part: z.number(),
})
export type RecordingSegmentEvent = z.infer<typeof segmentEventSchema>

/** Mirrors Swift `RecordingStopped` (a native-initiated end of session). */
const stoppedEventSchema = z.object({
  path: z.string(),
  sessionStartedMs: z.number(),
  part: z.number(),
  durationMs: z.number(),
  reason: z.string(),
})
export type RecordingStoppedEvent = z.infer<typeof stoppedEventSchema>

/** Mirrors Swift `NativeAction` (the OS entry-point handshake). */
const nativeActionSchema = z.object({ action: z.string() })
export type RecordingNativeActionEvent = z.infer<typeof nativeActionSchema>

export const subscribeRecordingLevel = definePluginEvent(
  'recording',
  'recordingLevel',
  levelEventSchema,
)
export const subscribeRecordingSegment = definePluginEvent(
  'recording',
  'recordingSegment',
  segmentEventSchema,
)
export const subscribeRecordingStopped = definePluginEvent(
  'recording',
  'recordingStopped',
  stoppedEventSchema,
)
export const subscribeRecordingNativeAction = definePluginEvent(
  'recording',
  'nativeAction',
  nativeActionSchema,
)
