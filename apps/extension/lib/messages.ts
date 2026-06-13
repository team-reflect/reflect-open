import { z } from 'zod'

/**
 * The popup ↔ background message contract. The popup persists the capture to
 * the queue itself, then sends `flush` — the queue (not the message) is the
 * source of truth, so a popup window closing mid-roundtrip loses nothing.
 */

/** Ask the background to flush the queue now. */
export interface FlushRequest {
  type: 'flush'
}

export function isFlushRequest(message: unknown): message is FlushRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type: unknown }).type === 'flush'
  )
}

/**
 * Why queued captures are being held for retry. `no-host`: the native host
 * isn't registered (Reflect not installed, or never launched since install);
 * `no-graph`: Reflect has never opened a graph; `io`: the host failed to
 * spool — all retried on the next flush trigger.
 */
export const holdReasonSchema = z.enum(['no-host', 'no-graph', 'io'])
export type HoldReason = z.infer<typeof holdReasonSchema>

/** The flush outcome the popup renders. */
export const flushResultSchema = z.object({
  /** Captures the host acked `queued` this flush. */
  sent: z.number(),
  /** Captures dropped as permanently unsendable (host said invalid-payload). */
  failed: z.number(),
  /**
   * Envelope ids of the dropped captures — the popup matches its own id here
   * to tell *its* capture's fate apart from an older queued one's (aggregate
   * counts alone would let a stale entry's rejection masquerade as the
   * current save failing).
   */
  rejectedIds: z.array(z.string()),
  /** Captures still held, with why. */
  held: z.number(),
  holdReason: holdReasonSchema.nullable(),
})
export type FlushResult = z.infer<typeof flushResultSchema>
