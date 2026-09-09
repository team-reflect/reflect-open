import { browser } from 'wxt/browser'
import { bookmarkWireSchema } from '@reflect/core/capture-envelope'
import fixtures from '../../../packages/core/src/actions/bookmark-envelope.fixtures.json'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureWireMessage } from '@reflect/core/capture-envelope'
import { discardQueuedCaptures, enqueueCapture, flushQueue, readQueue } from './flush'
import { sendToHost, type SendOutcome } from './native'

/** In-memory `chrome.storage.local` faithful to get(null)/set/remove. */
const store = new Map<string, unknown>()
const { bytesMock } = vi.hoisted(() => ({ bytesMock: vi.fn(async () => 0) }))

vi.mock('wxt/browser', () => ({
  browser: {
    permissions: { remove: vi.fn(async () => true) },
    storage: {
      local: {
        getBytesInUse: bytesMock,
        get: (keys: string | string[] | null) => {
          if (keys === null) {
            return Promise.resolve(Object.fromEntries(store))
          }
          const wanted = Array.isArray(keys) ? keys : [keys]
          return Promise.resolve(
            Object.fromEntries(
              wanted.filter((key) => store.has(key)).map((key) => [key, store.get(key)]),
            ),
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

const bookmark = bookmarkWireSchema.parse(fixtures.accepted[0])
bookmark.envelope.id = FIRST

it.each(['graph-mismatch', 'unsupported-version', 'invalid-payload'] as const)(
  'parks %s without blocking page captures, including after restart',
  async (reason) => {
    store.set('bookmarkSettings', {
      enabled: true,
      presentation: 'link',
      targetGraphId: bookmark.envelope.targetGraphId,
    })
    await enqueueCapture(bookmark)
    await enqueueCapture(wire(SECOND))
    sendMock.mockResolvedValueOnce(
      reason === 'invalid-payload'
        ? { kind: 'rejected', message: reason }
        : { kind: 'held', reason, message: reason },
    )
    expect((await flushQueue()).sent).toBe(1)
    const [parked] = await readQueue()
    expect(parked?.parked).toBe(reason)
    if (reason !== 'invalid-payload')
      expect(store.get('bookmarkSettings')).toMatchObject({ enabled: false })
    // Persisted state is sufficient; a new worker needs no in-memory failure list.
    await flushQueue()
    expect(sendMock).toHaveBeenCalledTimes(2)
    await flushQueue(true)
    expect(sendMock).toHaveBeenCalledTimes(reason === 'invalid-payload' ? 2 : 3)
  },
)

it('refuses the byte budget without removing accepted data', async () => {
  await enqueueCapture(bookmark)
  bytesMock.mockResolvedValueOnce(64 * 1024 * 1024)
  await expect(enqueueCapture(wire(SECOND))).rejects.toThrow('queue full')
  expect(await readQueue()).toHaveLength(1)
  await flushQueue()
  expect(store.has('captureQueueError')).toBe(false)
})

it('surfaces storage failure and lets a subsequent admission proceed', async () => {
  const write = vi
    .spyOn(browser.storage.local, 'set')
    .mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(enqueueCapture(bookmark)).rejects.toThrow('storage unavailable')
  expect(await readQueue()).toEqual([])
  await enqueueCapture(wire(SECOND))
  expect(await readQueue()).toHaveLength(1)
  write.mockRestore()
})

it('replays the same event after a lost ACK and discards only the selected entry', async () => {
  await enqueueCapture(bookmark)
  sendMock.mockResolvedValueOnce({ kind: 'held', reason: 'io', message: 'ACK lost' })
  await flushQueue()
  await flushQueue()
  expect(sendMock.mock.calls.map(([message]) => message.envelope.id)).toEqual([
    bookmark.envelope.id,
    bookmark.envelope.id,
  ])
  await enqueueCapture(bookmark)
  await enqueueCapture(wire(SECOND))
  store.set('captureQueueError', 'full')
  await discardQueuedCaptures(bookmark.envelope.id)
  expect((await readQueue()).map((entry) => entry.wire.envelope.id)).toEqual([SECOND])
  expect(store.has('captureQueueError')).toBe(false)
})

it('rechecks admission after asynchronous capacity reads', async () => {
  const capacity = Promise.withResolvers<number>()
  bytesMock.mockReturnValueOnce(capacity.promise)
  let allowed = true
  const admission = enqueueCapture(bookmark, () => allowed)
  await vi.waitFor(() => expect(browser.storage.local.getBytesInUse).toHaveBeenCalled())
  allowed = false
  capacity.resolve(0)
  await admission
  expect(await readQueue()).toEqual([])
})
