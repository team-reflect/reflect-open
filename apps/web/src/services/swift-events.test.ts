import { describe, expect, it } from 'vitest'
import { createTestLoggerService } from '@reflect/core/testing'
import { createHostEvents } from './swift-events.ts'

describe('createHostEvents', () => {
  it('delivers an event to every handler of its name', () => {
    const events = createHostEvents(createTestLoggerService())
    const seen: unknown[] = []
    events.on('a', (payload) => {
      seen.push(['first', payload])
    })
    events.on('a', (payload) => {
      seen.push(['second', payload])
    })
    events.on('b', (payload) => {
      seen.push(['other', payload])
    })

    events.dispatch('a', 1)

    expect(seen).toEqual([
      ['first', 1],
      ['second', 1],
    ])
  })

  it('gives the first listener of a name the events that waited, in order', async () => {
    const events = createHostEvents(createTestLoggerService())
    events.dispatch('a', 1)
    events.dispatch('a', 2)
    const seen: unknown[] = []

    events.on('a', (payload) => {
      seen.push(payload)
    })
    events.on('a', (payload) => {
      seen.push(['late', payload])
    })
    await Promise.resolve()
    events.dispatch('a', 3)

    expect(seen).toEqual([1, 2, 3, ['late', 3]])
  })

  it('keeps the newest 64 events that wait for a listener', async () => {
    const events = createHostEvents(createTestLoggerService())
    for (let i = 0; i < 70; i++) {
      events.dispatch('a', i)
    }
    const seen: unknown[] = []

    events.on('a', (payload) => {
      seen.push(payload)
    })
    await Promise.resolve()

    expect(seen).toHaveLength(64)
    expect(seen[0]).toBe(6)
  })

  it('stops delivery after the unsubscribe', async () => {
    const events = createHostEvents(createTestLoggerService())
    events.dispatch('a', 1)
    const seen: unknown[] = []

    const unlisten = events.on('a', (payload) => {
      seen.push(payload)
    })
    unlisten()
    await Promise.resolve()
    events.dispatch('a', 2)

    expect(seen).toEqual([])
  })
})
