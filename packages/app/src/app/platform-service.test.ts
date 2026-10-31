import { describe, expect, it } from 'vitest'
import type { PlatformFacts } from '@reflect/core'
import { createPlatformService } from './platform-service.ts'

const FACTS: PlatformFacts = {
  appPlatform: 'ios',
  isNativeShell: true,
  buildPlatform: 'ios',
  isMacosDesktop: false,
  isApplePlatform: true,
  hasMacosTitleBarOverlay: false,
  surface: { touchEditor: true, mobileApp: true },
  isDev: true,
  appVersion: '1.2.3',
}

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
        addEventListener(_type: string, listener: (event: MediaQueryListEvent) => void) {
          state.listeners.add(listener)
        },
        removeEventListener(_type: string, listener: (event: MediaQueryListEvent) => void) {
          state.listeners.delete(listener)
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

describe('createPlatformService', () => {
  it('exposes the facts it was given', () => {
    const platform = createPlatformService({ facts: FACTS, media: {} })
    expect(platform).toMatchObject(FACTS)
  })

  it('reads and follows the reduced-motion preference', () => {
    const media = createFakeMedia({ [REDUCED_MOTION]: true })
    const platform = createPlatformService({ facts: FACTS, media })
    expect(platform.prefersReducedMotion()).toBe(true)

    const seen: boolean[] = []
    const unsubscribe = platform.subscribeReducedMotion((value) => {
      seen.push(value)
    })
    media.set(REDUCED_MOTION, false)
    expect(seen).toEqual([false])
    expect(platform.prefersReducedMotion()).toBe(false)

    unsubscribe()
    expect(media.listenerCount(REDUCED_MOTION)).toBe(0)
  })

  it('reads and follows the color scheme', () => {
    const media = createFakeMedia({})
    const platform = createPlatformService({ facts: FACTS, media })
    expect(platform.colorScheme()).toBe('light')

    const seen: string[] = []
    const unsubscribe = platform.subscribeColorScheme((value) => {
      seen.push(value)
    })
    media.set(DARK, true)
    media.set(DARK, false)
    expect(seen).toEqual(['dark', 'light'])

    unsubscribe()
    expect(media.listenerCount(DARK)).toBe(0)
  })

  it('falls back to the legacy listener API', () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    const list = {
      matches: false,
      addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        return listeners.delete(listener)
      },
    }
    const platform = createPlatformService({
      facts: FACTS,
      media: { matchMedia: () => list as unknown as MediaQueryList },
    })

    const seen: boolean[] = []
    const unsubscribe = platform.subscribeReducedMotion((value) => {
      seen.push(value)
    })
    for (const listener of listeners) {
      listener({ matches: true } as MediaQueryListEvent)
    }
    expect(seen).toEqual([true])
    unsubscribe()
    expect(listeners.size).toBe(0)
  })

  it('answers no preference without `matchMedia`', () => {
    const platform = createPlatformService({ facts: FACTS, media: {} })
    expect(platform.prefersReducedMotion()).toBe(false)
    expect(platform.colorScheme()).toBe('light')
    const unsubscribe = platform.subscribeColorScheme(() => {})
    unsubscribe()
  })
})
