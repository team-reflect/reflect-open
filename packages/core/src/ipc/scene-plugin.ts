import { z } from 'zod'
import { definePluginCommand, definePluginEvent } from './plugin.ts'

/**
 * Typed bindings for `plugins/tauri-plugin-scene`, the iPadOS window scene's
 * traits. The payload schema mirrors the `SizeClassPayload` struct in
 * `ios/Sources/ScenePlugin.swift`; a field change there must land here in the
 * same review.
 */

const horizontalSizeClassSchema = z.enum(['compact', 'regular'])

/**
 * UIKit's horizontal size class of the window: `regular` for a full-screen
 * iPad or a wide Stage Manager window, `compact` for an iPhone, Slide Over, a
 * narrow Split View pane or a narrow window.
 */
export type HorizontalSizeClass = z.infer<typeof horizontalSizeClassSchema>

const sizeClassPayloadSchema = z.object({ horizontal: horizontalSizeClassSchema })
export type SizeClassPayload = z.infer<typeof sizeClassPayloadSchema>

export const sizeClassCommand = definePluginCommand<Record<string, never>, SizeClassPayload>(
  'scene',
  'size_class',
  sizeClassPayloadSchema,
)

/** Fires when the window crosses between compact and regular width. */
export const sizeClassChangedEvent = definePluginEvent(
  'scene',
  'sizeClassChanged',
  sizeClassPayloadSchema,
)
