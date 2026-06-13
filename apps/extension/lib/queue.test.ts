import { describe, expect, it } from 'vitest'
import type { CaptureWireMessage } from '@reflect/core/capture-envelope'
import {
  overCap,
  QUEUE_CAP,
  queueKey,
  queuedCaptureSchema,
  sortQueue,
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

function queued(id: string, queuedAt = 1): QueuedCapture {
  return { wire: wire(id), queuedAt, attempts: 0 }
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

describe('queueKey', () => {
  it('namespaces one storage key per capture', () => {
    expect(queueKey(ID)).toBe(`capture:${ID}`)
  })
})

describe('sortQueue', () => {
  it('orders oldest first, tie-broken by id', () => {
    const sorted = sortQueue([queued(uuid(2), 9), queued(uuid(1), 3), queued(uuid(0), 3)])
    expect(sorted.map((entry) => entry.wire.envelope.id)).toEqual([uuid(0), uuid(1), uuid(2)])
  })
})

describe('overCap', () => {
  it('returns nothing at or under the cap', () => {
    const full = Array.from({ length: QUEUE_CAP }, (_, index) => queued(uuid(index), index))
    expect(overCap(full)).toEqual([])
  })

  it('returns the oldest entries past the cap', () => {
    const entries = Array.from({ length: QUEUE_CAP + 2 }, (_, index) => queued(uuid(index), index))
    expect(overCap(entries)).toEqual([entries[0], entries[1]])
  })
})

describe('queuedCaptureSchema', () => {
  it('round-trips a stored entry and rejects garbage', () => {
    expect(queuedCaptureSchema.parse(queued(ID))).toEqual(queued(ID))
    expect(queuedCaptureSchema.safeParse({ nonsense: true }).success).toBe(false)
    expect(queuedCaptureSchema.safeParse('corrupt').success).toBe(false)
  })
})
