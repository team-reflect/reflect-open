import { browser } from 'wxt/browser'
import type { ExtensionCaptureWire } from '@reflect/core/capture-envelope'
import type { FlushResult } from './messages'
import { sendToHost } from './native'
import { readBookmarkSettings, writeBookmarkSettings } from './bookmark-settings'
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
export function enqueueCapture(
  wire: ExtensionCaptureWire,
  allowed: () => boolean = () => true,
): Promise<void> {
  const next = enqueueTail.then(async () => {
    const entries = await readQueue()
    if (entries.some((entry) => entry.wire.envelope.id === wire.envelope.id)) return
    const key = queueKey(wire.envelope.id)
    const entry = { wire, queuedAt: Date.now(), attempts: 0 }
    const bytes = await browser.storage.local.getBytesInUse(
      entries.map((item) => queueKey(item.wire.envelope.id)),
    )
    const addedBytes = new TextEncoder().encode(key + JSON.stringify(entry)).length
    if (!allowed()) return
    if (entries.length >= QUEUE_CAP || bytes + addedBytes > 64 * 1024 * 1024) {
      await browser.storage.local.set({
        captureQueueError: 'Capture paused: queue full. This capture was not saved.',
      })
      throw new Error(
        'Capture queue full. Existing captures are kept; retry after they are delivered.',
      )
    }
    await browser.storage.local.set({
      [key]: entry,
    })
    await browser.storage.local.remove('captureQueueError')
  })
  enqueueTail = next.catch(() => {})
  return next
}

let tail: Promise<FlushResult> | null = null

/** Deliver in serialized passes. Only host-wide failures stop later captures.
 * Explicit retries include parked graph/version errors, never invalid payloads.
 */
export function flushQueue(retryParked = false): Promise<FlushResult> {
  return scheduleQueuePass(() => runFlush(retryParked))
}

/** Explicitly discard pending captures after any in-flight delivery settles. */
export function discardQueuedCaptures(id: string): Promise<FlushResult> {
  return scheduleQueuePass(async () => {
    await browser.storage.local.remove([queueKey(id), 'captureQueueError'])
    return {
      sent: 0,
      failed: 0,
      rejectedIds: [],
      held: (await readQueue()).length,
      holdReason: null,
    }
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

async function runFlush(retryParked: boolean): Promise<FlushResult> {
  const snapshot = await readQueue()
  let sent = 0
  const rejectedIds: string[] = []
  let holdReason: FlushResult['holdReason'] = null

  for (const entry of snapshot) {
    if (entry.parked && (!retryParked || entry.parked === 'invalid-payload')) {
      holdReason ??= entry.parked
      continue
    }
    const id = entry.wire.envelope.id
    const outcome = await sendToHost(entry.wire)
    if (outcome.kind === 'queued') {
      await browser.storage.local.remove(queueKey(id))
      await browser.storage.local.remove('captureQueueError')
      sent += 1
    } else if (outcome.kind === 'rejected' && entry.wire.envelope.kind !== 'x-bookmark') {
      console.error(`capture ${id} dropped — the host rejected it: ${outcome.message}`)
      await browser.storage.local.remove(queueKey(id))
      rejectedIds.push(id)
    } else {
      const reason = outcome.kind === 'rejected' ? 'invalid-payload' : outcome.reason
      console.warn(`captures held (${reason}): ${outcome.message}`)
      const parked =
        reason === 'graph-mismatch' ||
        reason === 'unsupported-version' ||
        reason === 'invalid-payload'
          ? reason
          : undefined
      await browser.storage.local.set({
        [queueKey(id)]: { ...entry, attempts: entry.attempts + 1, ...(parked ? { parked } : {}) },
      })
      if (reason === 'graph-mismatch' || reason === 'unsupported-version') {
        await writeBookmarkSettings({ ...(await readBookmarkSettings()), enabled: false })
        await browser.storage.local.set({
          bookmarkError:
            'Automatic capture paused. Open the paired graph or update Reflect, then pair again.',
        })
      }
      holdReason = reason
      if (!parked) break
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
