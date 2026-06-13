import { z } from 'zod'
import { captureWireMessageSchema } from '@reflect/core/capture-envelope'

/**
 * The pending-capture queue, persisted in `chrome.storage.local` under **one
 * key per capture** (`capture:<id>`). Two contexts write the store — the
 * popup enqueues, the background flushes — and per-entry keys make every
 * mutation a single atomic `set`/`remove` on its own key: there is no shared
 * array to read-modify-write, so a save landing mid-flush can never be
 * clobbered by the flush writing back a stale snapshot. Pure helpers live
 * here (tested directly); the storage IO wraps them in `lib/flush.ts`.
 */

export const queuedCaptureSchema = z.object({
  wire: captureWireMessageSchema,
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

/**
 * Hard cap on held captures. Screenshots make entries multi-MB; past this
 * the oldest are dropped (the popup shows the pending count, so a stuck
 * queue is visible long before the cap bites).
 */
export const QUEUE_CAP = 50

/** Oldest first — the flush order, and the drop order at the cap. */
export function sortQueue(entries: QueuedCapture[]): QueuedCapture[] {
  return [...entries].sort(
    (first, second) =>
      first.queuedAt - second.queuedAt ||
      first.wire.envelope.id.localeCompare(second.wire.envelope.id),
  )
}

/** The oldest entries past {@link QUEUE_CAP} — what an enqueue must drop. */
export function overCap(entries: QueuedCapture[]): QueuedCapture[] {
  return sortQueue(entries).slice(0, Math.max(0, entries.length - QUEUE_CAP))
}
