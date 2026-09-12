import { z } from 'zod'
import { extensionCaptureWireSchema } from '@reflect/core/capture-envelope'

/** Durable captures keyed by event ID; the background owns admission and delivery. */

export const queuedCaptureSchema = z.object({
  wire: extensionCaptureWireSchema,
  /** Epoch ms when the capture entered the queue. */
  queuedAt: z.number(),
  /** Send attempts so far — surfaced in the popup's pending count tooltip. */
  attempts: z.number(),
})

export type QueuedCapture = z.infer<typeof queuedCaptureSchema>

/** Storage-key prefix for queued captures. */
export const QUEUE_KEY_PREFIX = 'capture:'

/** The storage key holding one capture. */
export function queueKey(id: string): string {
  return `${QUEUE_KEY_PREFIX}${id}`
}

/** Reject new captures at this bound without evicting accepted entries. */
export const QUEUE_CAP = 50

/** Oldest captures are delivered first. */
export function sortQueue(entries: QueuedCapture[]): QueuedCapture[] {
  return [...entries].sort(
    (first, second) =>
      first.queuedAt - second.queuedAt ||
      first.wire.envelope.id.localeCompare(second.wire.envelope.id),
  )
}
