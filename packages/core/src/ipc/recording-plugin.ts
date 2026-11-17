import type {
  RecordingLevelEvent,
  RecordingNativeActionEvent,
  RecordingSegmentEvent,
  RecordingStoppedEvent,
} from '@reflect/types'
import { z } from 'zod'
import { definePluginEvent } from './plugin.ts'

/**
 * The events of the `plugin:recording` commands, the native audio-memo
 * recorder (`apps/ios/Sources/Capabilities/RecordingCapability.swift`). The
 * command table holds the commands; `crates/types/src/shell.rs` holds every
 * payload type.
 */

export type {
  RecordingLevelEvent,
  RecordingNativeActionEvent,
  RecordingSegmentEvent,
  RecordingSessionStart,
  RecordingStatus,
  RecordingStoppedEvent,
  RecordingStopResponse,
  StagedRecordingFile,
  StartRecordingOptions,
} from '@reflect/types'

const levelEventSchema = z.object({
  level: z.number(),
  elapsedMs: z.number(),
}) satisfies z.ZodType<RecordingLevelEvent>

const segmentEventSchema = z.object({
  path: z.string(),
  sessionStartedMs: z.number(),
  part: z.number(),
}) satisfies z.ZodType<RecordingSegmentEvent>

const stoppedEventSchema = z.object({
  path: z.string(),
  sessionStartedMs: z.number(),
  part: z.number(),
  durationMs: z.number(),
  reason: z.string(),
}) satisfies z.ZodType<RecordingStoppedEvent>

const nativeActionSchema = z.object({
  action: z.string(),
}) satisfies z.ZodType<RecordingNativeActionEvent>

export const recordingLevelEvent = definePluginEvent(
  'recording',
  'recordingLevel',
  levelEventSchema,
)
export const recordingSegmentEvent = definePluginEvent(
  'recording',
  'recordingSegment',
  segmentEventSchema,
)
export const recordingStoppedEvent = definePluginEvent(
  'recording',
  'recordingStopped',
  stoppedEventSchema,
)
export const recordingNativeActionEvent = definePluginEvent(
  'recording',
  'nativeAction',
  nativeActionSchema,
)
