import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureWireMessage } from '@reflect/core/capture-envelope'
import { enqueueCapture, flushQueue, readQueue } from './flush'
import { sendToHost, type SendOutcome } from './native'

/** In-memory `chrome.storage.local` faithful to get(null)/set/remove. */
const store = new Map<string, unknown>()

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: (keys: string | string[] | null) => {
          if (keys === null) {
            return Promise.resolve(Object.fromEntries(store))
          }
          const wanted = Array.isArray(keys) ? keys : [keys]
          return Promise.resolve(
            Object.fromEntries(wanted.filter((key) => store.has(key)).map((key) => [key, store.get(key)])),
          )
        },
        set: (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            store.set(key, value)
          }
          return Promise.resolve()
        },
        remove: (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            store.delete(key)
          }
          return Promise.resolve()
        },
      },
    },
  },
}))
vi.mock('./native', () => ({
  sendToHost: vi.fn(),
}))

const sendMock = vi.mocked(sendToHost)

function wire(id: string): CaptureWireMessage {
  return {
    envelope: {
      version: 1,
      id,
      url: 'https://example.com',
      title: 'Example',
      capturedAt: '2026-06-12T15:30:22.845Z',
      source: 'extension',
    },
  }
}

const FIRST = '00000000-0000-4000-8000-000000000001'
const SECOND = '00000000-0000-4000-8000-000000000002'

beforeEach(() => {
  vi.clearAllMocks()
  store.clear()
  sendMock.mockResolvedValue({ kind: 'queued' })
})

describe('flushQueue', () => {
  it('sends queued captures oldest first and empties the queue', async () => {
    await enqueueCapture(wire(FIRST))
    await enqueueCapture(wire(SECOND))

    const result = await flushQueue()

    expect(result).toEqual({ sent: 2, failed: 0, rejectedIds: [], held: 0, holdReason: null })
    expect(sendMock.mock.calls.map(([sent]) => sent.envelope.id)).toEqual([FIRST, SECOND])
    expect(await readQueue()).toEqual([])
  })

  it('a flush requested mid-pass starts a fresh pass that sees later enqueues', async () => {
    // The first pass blocks inside sendToHost; a capture enqueued (and
    // flushed) during that window must NOT be handed the stale pass — its
    // own flush promise must cover it, and the stale pass's per-key removals
    // must not clobber it out of storage.
    let releaseFirst: (outcome: SendOutcome) => void = () => {}
    sendMock.mockImplementationOnce(
      () =>
        new Promise<SendOutcome>((resolve) => {
          releaseFirst = resolve
        }),
    )
    await enqueueCapture(wire(FIRST))
    const firstFlush = flushQueue()
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1))

    await enqueueCapture(wire(SECOND))
    const secondFlush = flushQueue()
    releaseFirst({ kind: 'queued' })

    expect((await firstFlush).sent).toBe(1)
    expect((await secondFlush).sent).toBe(1)
    expect(sendMock.mock.calls.map(([sent]) => sent.envelope.id)).toEqual([FIRST, SECOND])
    expect(await readQueue()).toEqual([])
  })

  it('reports rejected ids so a stale drop cannot masquerade as the new save failing', async () => {
    sendMock.mockImplementation((sent) =>
      Promise.resolve(
        sent.envelope.id === FIRST
          ? { kind: 'rejected', message: 'invalid payload' }
          : { kind: 'queued' },
      ),
    )
    await enqueueCapture(wire(FIRST))
    await enqueueCapture(wire(SECOND))

    const result = await flushQueue()

    expect(result).toEqual({
      sent: 1,
      failed: 1,
      rejectedIds: [FIRST],
      held: 0,
      holdReason: null,
    })
    expect(await readQueue()).toEqual([])
  })

  it('a hold stops the pass and keeps every remaining capture, attempts stamped', async () => {
    sendMock.mockResolvedValue({ kind: 'held', reason: 'no-host', message: 'host not found' })
    await enqueueCapture(wire(FIRST))
    await enqueueCapture(wire(SECOND))

    const result = await flushQueue()

    expect(result).toEqual({ sent: 0, failed: 0, rejectedIds: [], held: 2, holdReason: 'no-host' })
    expect(sendMock).toHaveBeenCalledTimes(1) // the condition affects all — stop
    const queue = await readQueue()
    expect(queue.map((entry) => entry.attempts)).toEqual([1, 0])
  })

  it('skips unreadable stored entries instead of failing the whole queue', async () => {
    store.set('capture:corrupt', { nonsense: true })
    await enqueueCapture(wire(FIRST))

    const result = await flushQueue()

    expect(result.sent).toBe(1)
    expect(await readQueue()).toEqual([])
  })
})
