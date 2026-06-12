import { browser } from 'wxt/browser'
import type { CaptureWireMessage } from '@reflect/core/capture-envelope'
import type { FlushResult } from './messages'
import { sendToHost } from './native'
import {
  markAttempt,
  pushCapture,
  removeCapture,
  storedQueueSchema,
  type QueuedCapture,
} from './queue'

/**
 * Queue persistence + the flush driver, shared by the background (which owns
 * retries) and the popup (which enqueues before asking for a flush). The
 * queue is written back after **every** entry-level change, so a service
 * worker dying mid-flush loses at most one in-flight send — never an acked
 * removal or a captured page.
 */

const QUEUE_KEY = 'captureQueue'

export async function readQueue(): Promise<QueuedCapture[]> {
  const stored = await browser.storage.local.get(QUEUE_KEY)
  return storedQueueSchema.parse(stored[QUEUE_KEY])
}

async function writeQueue(queue: QueuedCapture[]): Promise<void> {
  await browser.storage.local.set({ [QUEUE_KEY]: queue })
}

/** Persist a capture (cap-enforced) — the durable step before any flush. */
export async function enqueueCapture(wire: CaptureWireMessage): Promise<void> {
  const { queue, dropped } = pushCapture(await readQueue(), wire, Date.now())
  if (dropped.length > 0) {
    console.warn(`capture queue at cap: dropped ${dropped.length} oldest capture(s)`)
  }
  await writeQueue(queue)
}

let inFlight: Promise<FlushResult> | null = null

/**
 * Send every queued capture to the host, oldest first. A `queued` ack
 * removes the entry; `invalid-payload` drops it (it can never succeed); any
 * hold (host missing, no graph, IO) stops the pass — the condition affects
 * every later entry too — and the next trigger retries. Single-flight.
 */
export function flushQueue(): Promise<FlushResult> {
  inFlight ??= runFlush().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runFlush(): Promise<FlushResult> {
  const snapshot = await readQueue()
  let queue = snapshot
  let sent = 0
  let failed = 0
  let holdReason: FlushResult['holdReason'] = null

  for (const entry of snapshot) {
    const id = entry.wire.envelope.id
    const outcome = await sendToHost(entry.wire)
    if (outcome.kind === 'queued') {
      queue = removeCapture(queue, id)
      sent += 1
    } else if (outcome.kind === 'rejected') {
      console.error(`capture ${id} dropped — the host rejected it: ${outcome.message}`)
      queue = removeCapture(queue, id)
      failed += 1
    } else {
      console.warn(`captures held (${outcome.reason}): ${outcome.message}`)
      queue = markAttempt(queue, id)
      holdReason = outcome.reason
      await writeQueue(queue)
      break
    }
    await writeQueue(queue)
  }

  return { sent, failed, held: queue.length, holdReason }
}
