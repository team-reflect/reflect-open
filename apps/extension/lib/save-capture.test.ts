import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueueCapture, readQueue } from './flush'
import { buildWireMessage } from './capture-message'
import { queueKey } from './queue'
import { saveCapture } from './save-capture'

const store = new Map<string, unknown>()

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        getBytesInUse: vi.fn(async () => 0),
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

const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const CAPTURED_AT = new Date('2026-06-12T15:30:22.845Z')

function captureInput() {
  return {
    id: ID,
    capturedAt: CAPTURED_AT,
    url: 'https://example.com/article',
    title: 'Example',
  }
}

beforeEach(() => {
  store.clear()
})

describe('saveCapture', () => {
  it('reports queued when the immediate flush removes this capture', async () => {
    const outcome = await saveCapture(captureInput(), async () => {
      store.delete(queueKey(ID))
      return { sent: 1, failed: 0, rejectedIds: [], held: 0, holdReason: null }
    })

    expect(outcome).toEqual({ fate: 'queued' })
  })

  it('reports held when this capture remains queued after the flush', async () => {
    const result = { sent: 0, failed: 0, rejectedIds: [], held: 1, holdReason: 'no-host' }

    const outcome = await saveCapture(captureInput(), async () => result)

    expect(outcome).toEqual({ fate: 'held', result })
  })

  it('reports rejected by matching this capture id, not aggregate counts', async () => {
    const outcome = await saveCapture(captureInput(), async () => ({
      sent: 0,
      failed: 1,
      rejectedIds: [ID],
      held: 0,
      holdReason: null,
    }))

    expect(outcome).toEqual({ fate: 'rejected' })
  })
})

it('serializes concurrent admission and preserves every accepted capture at capacity', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 51 }, (_, index) =>
      enqueueCapture(
        buildWireMessage({
          ...captureInput(),
          id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        }),
      ),
    ),
  )
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(50)
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  const queue = await readQueue()
  expect(queue).toHaveLength(50)
  expect(queue.some((entry) => entry.wire.envelope.id.endsWith('000000000000'))).toBe(true)
})
