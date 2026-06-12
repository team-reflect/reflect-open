import { describe, expect, it } from 'vitest'
import type { CaptureWireMessage } from '@reflect/core/capture-envelope'
import {
  markAttempt,
  pushCapture,
  QUEUE_CAP,
  removeCapture,
  storedQueueSchema,
  type QueuedCapture,
} from './queue'

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

const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

function queued(id: string): QueuedCapture {
  return { wire: wire(id), queuedAt: 1, attempts: 0 }
}

describe('pushCapture', () => {
  it('appends with a fresh attempt counter', () => {
    const { queue, dropped } = pushCapture([], wire(ID), 123)
    expect(queue).toEqual([{ wire: wire(ID), queuedAt: 123, attempts: 0 }])
    expect(dropped).toEqual([])
  })

  it('drops the oldest entries past the cap, reporting them', () => {
    const full = Array.from({ length: QUEUE_CAP }, (_, index) =>
      queued(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    )
    const { queue, dropped } = pushCapture(full, wire(ID), 9)
    expect(queue).toHaveLength(QUEUE_CAP)
    expect(dropped).toEqual([full[0]])
    expect(queue.at(-1)?.wire.envelope.id).toBe(ID)
  })
})

describe('removeCapture', () => {
  it('removes only the matching envelope', () => {
    const other = '00000000-0000-4000-8000-000000000001'
    expect(removeCapture([queued(ID), queued(other)], ID)).toEqual([queued(other)])
  })
})

describe('markAttempt', () => {
  it('increments only the matching entry', () => {
    const other = '00000000-0000-4000-8000-000000000001'
    const next = markAttempt([queued(ID), queued(other)], ID)
    expect(next[0].attempts).toBe(1)
    expect(next[1].attempts).toBe(0)
  })
})

describe('storedQueueSchema', () => {
  it('round-trips a valid stored queue', () => {
    expect(storedQueueSchema.parse([queued(ID)])).toEqual([queued(ID)])
  })

  it('degrades anything unreadable to an empty queue', () => {
    expect(storedQueueSchema.parse(undefined)).toEqual([])
    expect(storedQueueSchema.parse('corrupt')).toEqual([])
    expect(storedQueueSchema.parse([{ nonsense: true }])).toEqual([])
  })
})
