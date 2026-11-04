import { describe, expect, it } from 'vitest'
import { createSystemPreferencesService } from './system-preferences-service.ts'

interface FakeQuery {
  matches: boolean
  listeners: Set<(event: MediaQueryListEvent) => void>
  lists: Array<{ matches: boolean }>
}

function createFakeMedia(initial: Record<string, boolean>): {
  matchMedia: (query: string) => MediaQueryList
  set: (query: string, matches: boolean) => void
  listenerCount: (query: string) => number
} {
  const queries = new Map<string, FakeQuery>()
  function entry(query: string): FakeQuery {
    let found = queries.get(query)
    if (!found) {
      found = { matches: initial[query] ?? false, listeners: new Set(), lists: [] }
      queries.set(query, found)
    }
    return found
  }
  return {
    matchMedia(query) {
      const state = entry(query)
      const list = {
        matches: state.matches,
        addEventListener(
          _type: string,
          listener: (event: MediaQueryListEvent) => void,
          options?: AddEventListenerOptions,
        ) {
          state.listeners.add(listener)
          options?.signal?.addEventListener('abort', () => state.listeners.delete(listener))
        },
      }
      state.lists.push(list)
      return list as unknown as MediaQueryList
    },
    set(query, matches) {
      const state = entry(query)
      state.matches = matches
      for (const list of state.lists) {
        list.matches = matches
      }
      for (const listener of state.listeners) {
        listener({ matches } as MediaQueryListEvent)
      }
    },
    listenerCount: (query) => entry(query).listeners.size,
  }
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const DARK = '(prefers-color-scheme: dark)'

describe('createSystemPreferencesService', () => {
  it('reads and follows the reduced-motion preference', () => {
    const media = createFakeMedia({ [REDUCED_MOTION]: true })
    const preferences = createSystemPreferencesService({ media })
    expect(preferences.reducedMotion.get()).toBe(true)

    const seen: boolean[] = []
    const unsubscribe = preferences.reducedMotion.subscribe(() => {
      seen.push(preferences.reducedMotion.get())
    })
    media.set(REDUCED_MOTION, false)
    expect(seen).toEqual([false])

    unsubscribe()
    expect(media.listenerCount(REDUCED_MOTION)).toBe(0)
  })

  it('reads and follows the color scheme', () => {
    const media = createFakeMedia({})
    const preferences = createSystemPreferencesService({ media })
    expect(preferences.colorScheme.get()).toBe('light')

    const seen: string[] = []
    const unsubscribe = preferences.colorScheme.subscribe(() => {
      seen.push(preferences.colorScheme.get())
    })
    media.set(DARK, true)
    media.set(DARK, false)
    expect(seen).toEqual(['dark', 'light'])

    unsubscribe()
    expect(media.listenerCount(DARK)).toBe(0)
  })

  it('does not subscribe to a list without `addEventListener`', () => {
    const list = { matches: true }
    const preferences = createSystemPreferencesService({
      media: { matchMedia: () => list as unknown as MediaQueryList },
    })
    expect(preferences.reducedMotion.get()).toBe(true)
    const unsubscribe = preferences.reducedMotion.subscribe(() => {})
    unsubscribe()
  })

  it('answers no preference without `matchMedia`', () => {
    const preferences = createSystemPreferencesService({ media: {} })
    expect(preferences.reducedMotion.get()).toBe(false)
    expect(preferences.colorScheme.get()).toBe('light')
    const unsubscribe = preferences.colorScheme.subscribe(() => {})
    unsubscribe()
  })
})
