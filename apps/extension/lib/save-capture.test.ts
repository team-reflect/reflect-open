import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queueKey } from './queue'
import { saveCapture } from './save-capture'

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock('wxt/browser', async () => ({
  browser: {
    storage: { local: (await import('./test-utils/storage-mock')).createStorageLocalMock(store) },
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
