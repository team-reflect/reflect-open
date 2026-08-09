import { z } from 'zod'
import { definePluginCommands, definePluginEvent } from './plugin'

/**
 * Typed bindings for `plugins/tauri-plugin-recording` — the native audio-memo
 * recorder (mobile-only; the desktop half of every command rejects with
 * `UnsupportedPlatform`, see the plugin's `desktop.rs`). Each schema mirrors
 * a serde model in the plugin's `src/models.rs` (commands) or an `Encodable`
 * struct in `ios/Sources/RecordingPlugin.swift` (events); a field change
 * there must land here in the same review.
 */

const emptyArgs = z.object({})
const voidResult = z.null()

/** Mirrors `StagedPathRequest`: the staged-file path argument. */
const stagedPathArgs = z.object({ request: z.object({ path: z.string() }) })

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

const callRecording = definePluginCommands('recording', {
  start_recording: {
    // Mirrors `StartRequest` under the command's `request` parameter.
    args: z.object({ request: z.object({ maxDurationMs: z.number() }) }),
    result: voidResult,
  },
  stop_recording: { args: emptyArgs, result: stopResponseSchema },
  cancel_recording: { args: emptyArgs, result: voidResult },
  recording_status: { args: emptyArgs, result: recordingStatusSchema },
  actions_ready: { args: emptyArgs, result: voidResult },
  action_performed: { args: emptyArgs, result: voidResult },
  list_staged: { args: emptyArgs, result: listStagedSchema },
  read_staged: { args: stagedPathArgs, result: readStagedSchema },
  delete_staged: { args: stagedPathArgs, result: voidResult },
})

export interface StartRecordingOptions {
  /** Auto-stop cap in ms, enforced natively even if JS never wakes. */
  maxDurationMs: number
}

/** Ask for the microphone and start recording into the plugin's staging dir. */
export async function startRecording(options: StartRecordingOptions): Promise<void> {
  await callRecording('start_recording', { request: options })
}

/** Stop the active recording; rejects when nothing is recording. */
export async function stopRecording(): Promise<RecordingStopResponse> {
  return await callRecording('stop_recording', {})
}

/** Stop the active recording and discard its file. */
export async function cancelRecording(): Promise<void> {
  await callRecording('cancel_recording', {})
}

/** Whether a native recording is live right now (webview-reload reconcile). */
export async function recordingStatus(): Promise<RecordingStatus> {
  return await callRecording('recording_status', {})
}

/** The webview's action surface is mounted — deliver any queued native action. */
export async function actionsReady(): Promise<void> {
  await callRecording('actions_ready', {})
}

/** Retire the delivered native action so it doesn't re-fire on next launch. */
export async function actionPerformed(): Promise<void> {
  await callRecording('action_performed', {})
}

/** Finished recordings still in staging (crash orphans, files mid-ingest). */
export async function listStaged(): Promise<StagedRecordingFile[]> {
  const { files } = await callRecording('list_staged', {})
  return files
}

/** A staged recording's bytes, base64-encoded. */
export async function readStaged(path: string): Promise<string> {
  const { base64 } = await callRecording('read_staged', { request: { path } })
  return base64
}

/** Remove a staged recording once its bytes are durable in the graph. */
export async function deleteStaged(path: string): Promise<void> {
  await callRecording('delete_staged', { request: { path } })
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
export type NativeActionEvent = z.infer<typeof nativeActionSchema>

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
export const subscribeNativeAction = definePluginEvent(
  'recording',
  'nativeAction',
  nativeActionSchema,
)
