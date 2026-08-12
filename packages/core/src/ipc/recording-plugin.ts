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

/** Mirrors `StopResponse`: a finished recording still in staging. */
const stopResponseSchema = z.object({
  path: z.string(),
  durationMs: z.number(),
  modifiedMs: z.number(),
})
export type RecordingStopResponse = z.infer<typeof stopResponseSchema>

/** Mirrors `RecordingStatusResponse`. */
const recordingStatusSchema = z.object({ recording: z.boolean(), elapsedMs: z.number() })
export type RecordingStatus = z.infer<typeof recordingStatusSchema>

/** Mirrors `StagedFile` (one entry of `ListStagedResponse`). */
const stagedFileSchema = z.object({ path: z.string(), modifiedMs: z.number() })
export type StagedRecordingFile = z.infer<typeof stagedFileSchema>

const listStagedSchema = z.object({ files: z.array(stagedFileSchema) })
const readStagedSchema = z.object({ base64: z.string() })

// Command args mirror the serde request models (`StartRequest`,
// `StagedPathRequest`) under the command's `request` parameter.
const startRecordingCommand = definePluginCommand<{ request: StartRecordingOptions }, unknown>(
  'recording',
  'start_recording',
  ignoredResult,
)
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
const readStagedCommand = definePluginCommand<{ request: { path: string } }, { base64: string }>(
  'recording',
  'read_staged',
  readStagedSchema,
)
const deleteStagedCommand = definePluginCommand<{ request: { path: string } }, unknown>(
  'recording',
  'delete_staged',
  ignoredResult,
)

export interface StartRecordingOptions {
  /** Auto-stop cap in ms, enforced natively even if JS never wakes. */
  maxDurationMs: number
}

/** Ask for the microphone and start recording into the plugin's staging dir. */
export async function startRecording(options: StartRecordingOptions): Promise<void> {
  await startRecordingCommand({ request: options })
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

/** A staged recording's bytes, base64-encoded. */
export async function readStaged(path: string): Promise<string> {
  const { base64 } = await readStagedCommand({ request: { path } })
  return base64
}

/** Remove a staged recording once its bytes are durable in the graph. */
export async function deleteStaged(path: string): Promise<void> {
  await deleteStagedCommand({ request: { path } })
}

/** Mirrors Swift `RecordingLevel` (~10 Hz while recording, foreground only). */
const levelEventSchema = z.object({ level: z.number(), elapsedMs: z.number() })
export type RecordingLevelEvent = z.infer<typeof levelEventSchema>

/** Mirrors Swift `RecordingStopped` (a native-initiated stop). */
const stoppedEventSchema = z.object({
  path: z.string(),
  durationMs: z.number(),
  modifiedMs: z.number(),
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
