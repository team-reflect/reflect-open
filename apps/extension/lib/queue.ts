import { z } from 'zod'
import { captureWireMessageSchema, type CaptureWireMessage } from '@reflect/core/capture-envelope'

/**
 * The pending-capture queue, persisted in `chrome.storage.local`: the single
 * source of truth for every capture the host hasn't acked yet. The popup
 * enqueues **before** asking the background to flush, so its window closing
 * mid-send can never drop a capture; the background removes entries only on
 * a `queued` ack from the native host. Pure operations live here (tested
 * directly); the storage IO wraps them in `entrypoints/background.ts`.
 */

export const queuedCaptureSchema = z.object({
  wire: captureWireMessageSchema,
  /** Epoch ms when the capture entered the queue. */
  queuedAt: z.number(),
  /** Send attempts so far — surfaced in the popup's pending count tooltip. */
  attempts: z.number(),
})

export type QueuedCapture = z.infer<typeof queuedCaptureSchema>

/** Tolerant read of a stored queue: anything unreadable drops to empty. */
export const storedQueueSchema = z.array(queuedCaptureSchema).catch([])

/**
 * Hard cap on held captures. Screenshots make entries multi-MB; past this
 * the oldest are dropped (the popup shows the pending count, so a stuck
 * queue is visible long before the cap bites).
 */
export const QUEUE_CAP = 50

export interface PushOutcome {
  queue: QueuedCapture[]
  /** Entries dropped to enforce {@link QUEUE_CAP}, oldest first. */
  dropped: QueuedCapture[]
}

/** Append a capture, enforcing the cap (drop-oldest, reported not silent). */
export function pushCapture(
  queue: QueuedCapture[],
  wire: CaptureWireMessage,
  queuedAt: number,
): PushOutcome {
  const next = [...queue, { wire, queuedAt, attempts: 0 }]
  const overflow = Math.max(0, next.length - QUEUE_CAP)
  return { queue: next.slice(overflow), dropped: next.slice(0, overflow) }
}

/** Remove the entry for `id` (after a `queued` ack, or as a poison drop). */
export function removeCapture(queue: QueuedCapture[], id: string): QueuedCapture[] {
  return queue.filter((entry) => entry.wire.envelope.id !== id)
}

/** Stamp one more attempt on the entry for `id`. */
export function markAttempt(queue: QueuedCapture[], id: string): QueuedCapture[] {
  return queue.map((entry) =>
    entry.wire.envelope.id === id ? { ...entry, attempts: entry.attempts + 1 } : entry,
  )
}
