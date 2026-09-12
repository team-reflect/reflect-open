import type { ExtensionCaptureWire } from '@reflect/core/capture-envelope'
import { buildWireMessage, type BuildWireMessageInput } from './capture-message'
import { enqueueCapture, readQueue } from './flush'
import { flushResultSchema, type FlushResult } from './messages'

/**
 * The fate of one just-enqueued capture after its immediate flush attempt.
 */
export type SaveOutcome =
  | { fate: 'queued' }
  | { fate: 'held'; result: FlushResult }
  | { fate: 'rejected' }

/**
 * Persist the capture, flush, and report this capture's fate. Aggregate flush
 * counts can't distinguish an older queued entry's failure from this save, so
 * the verdict comes from this envelope id's rejection or continued presence.
 */
export async function saveCapture(
  page: BuildWireMessageInput,
  flush: () => Promise<unknown>,
  enqueue: (wire: ExtensionCaptureWire) => Promise<void> = enqueueCapture,
): Promise<SaveOutcome> {
  const wire = buildWireMessage(page)
  await enqueue(wire)
  const result = flushResultSchema.parse(await flush())
  if (result.rejectedIds.includes(wire.envelope.id)) {
    return { fate: 'rejected' }
  }
  const queue = await readQueue()
  const stillHeld = queue.some((entry) => entry.wire.envelope.id === wire.envelope.id)
  return stillHeld ? { fate: 'held', result } : { fate: 'queued' }
}
