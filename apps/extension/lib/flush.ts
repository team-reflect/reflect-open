import { browser } from 'wxt/browser'
import type { ExtensionCaptureWire } from '@reflect/core/capture-envelope'
import type { FlushResult } from './messages'
import { sendToHost } from './native'
import {
  QUEUE_CAP,
  queueKey,
  QUEUE_KEY_PREFIX,
  queuedCaptureSchema,
  sortQueue,
  type QueuedCapture,
} from './queue'

/** Background-owned queue admission and delivery; popup reads are read-only. */

/** Every queued capture, oldest first. Unreadable entries are skipped. */
export async function readQueue(): Promise<QueuedCapture[]> {
  const stored = await browser.storage.local.get(null)
  const entries: QueuedCapture[] = []
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(QUEUE_KEY_PREFIX)) {
      continue
    }
    const parsed = queuedCaptureSchema.safeParse(value)
    if (parsed.success) {
      entries.push(parsed.data)
    }
  }
  return sortQueue(entries)
}

/** Persist a capture — the durable step before any flush. Cap-enforced. */
let enqueueTail = Promise.resolve()

/** Only the background worker calls this serialized admission boundary. */
export function enqueueCapture(wire: ExtensionCaptureWire): Promise<void> {
  const next = enqueueTail.then(async () => {
    const entries = await readQueue()
    if (entries.some((entry) => entry.wire.envelope.id === wire.envelope.id)) return
    const bytes = new TextEncoder().encode(JSON.stringify([...entries, wire])).length
    if (entries.length >= QUEUE_CAP || bytes > 64 * 1024 * 1024) {
      await browser.storage.local.set({
        captureQueueError: 'Capture paused: queue full. This capture was not saved.',
      })
      throw new Error(
        'Capture queue full. Existing captures are kept; retry after they are delivered.',
      )
    }
    await browser.storage.local.set({
      [queueKey(wire.envelope.id)]: { wire, queuedAt: Date.now(), attempts: 0 },
    })
    await browser.storage.local.remove('captureQueueError')
  })
  enqueueTail = next.catch(() => {})
  return next
}

let tail: Promise<FlushResult> | null = null

/**
 * Send every queued capture to the host, oldest first. A `queued` ack
 * removes the entry; `invalid-payload` drops it (it can never succeed); any
 * hold (host missing, no graph, IO) stops the pass — the condition affects
 * every later entry too — and the next trigger retries.
 *
 * Passes never overlap, but a caller is never handed an already-running
 * pass either: its pass **starts after** every earlier request, so a save
 * that enqueued just before calling this is guaranteed a pass whose
 * snapshot includes it (an in-flight pass started earlier would miss it
 * and falsely report it queued). A pass over an already-empty queue is one
 * storage read, so the occasional chained extra pass costs nothing.
 */
export function flushQueue(): Promise<FlushResult> {
  return scheduleQueuePass(runFlush)
}

/** Explicitly discard pending captures after any in-flight delivery settles. */
export function discardQueuedCaptures(): Promise<FlushResult> {
  return scheduleQueuePass(async () => {
    const entries = await readQueue()
    await browser.storage.local.remove(entries.map((entry) => queueKey(entry.wire.envelope.id)))
    return { sent: 0, failed: 0, rejectedIds: [], held: 0, holdReason: null }
  })
}

function scheduleQueuePass(pass: () => Promise<FlushResult>): Promise<FlushResult> {
  const next = tail === null ? pass() : tail.then(pass, pass)
  tail = next
  const cleanup = (): void => {
    if (tail === next) {
      tail = null
    }
  }
  void next.then(cleanup, cleanup)
  return next
}

async function runFlush(): Promise<FlushResult> {
  const snapshot = await readQueue()
  let sent = 0
  const rejectedIds: string[] = []
  let holdReason: FlushResult['holdReason'] = null

  for (const entry of snapshot) {
    const id = entry.wire.envelope.id
    const outcome = await sendToHost(entry.wire)
    if (outcome.kind === 'queued') {
      await browser.storage.local.remove(queueKey(id))
      sent += 1
    } else if (outcome.kind === 'rejected' && entry.wire.envelope.kind !== 'x-bookmark') {
      console.error(`capture ${id} dropped — the host rejected it: ${outcome.message}`)
      await browser.storage.local.remove(queueKey(id))
      rejectedIds.push(id)
    } else {
      const reason = outcome.kind === 'rejected' ? 'invalid-payload' : outcome.reason
      console.warn(`captures held (${reason}): ${outcome.message}`)
      await browser.storage.local.set({
        [queueKey(id)]: { ...entry, attempts: entry.attempts + 1 },
      })
      if (reason === 'graph-mismatch' || reason === 'unsupported-version') {
        const stored = await browser.storage.local.get('bookmarkSettings')
        const settings = stored['bookmarkSettings']
        if (typeof settings === 'object' && settings !== null) {
          await browser.storage.local.set({
            bookmarkSettings: { ...settings, enabled: false },
            bookmarkError:
              'Automatic capture paused. Open the paired graph or update Reflect, then pair again.',
          })
        }
      }
      holdReason = reason
      break
    }
  }

  return {
    sent,
    failed: rejectedIds.length,
    rejectedIds,
    held: (await readQueue()).length,
    holdReason,
  }
}
