import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPostSeen, isPostSeen, markPostSeen, SEEN_CAP, seenKey } from './seen'

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

beforeEach(() => {
  store.clear()
})

describe('seen posts', () => {
  it('remembers, answers, and forgets a post', async () => {
    await expect(isPostSeen('20')).resolves.toBe(false)
    await markPostSeen('20', () => 1000)
    expect(store.get(seenKey('20'))).toBe(1000)
    await expect(isPostSeen('20')).resolves.toBe(true)
    await clearPostSeen('20')
    await expect(isPostSeen('20')).resolves.toBe(false)
  })

  it('prunes the oldest entries past the cap, leaving other keys alone', async () => {
    store.set('capture:x', { unrelated: true })
    for (let index = 0; index < SEEN_CAP; index += 1) {
      store.set(seenKey(String(index)), index)
    }
    await markPostSeen('newest', () => SEEN_CAP + 1)

    expect(store.has(seenKey('0'))).toBe(false)
    expect(store.has(seenKey('1'))).toBe(true)
    expect(store.has(seenKey('newest'))).toBe(true)
    expect(store.has('capture:x')).toBe(true)
    expect([...store.keys()].filter((key) => key.startsWith('seen:x:'))).toHaveLength(SEEN_CAP)
  })
})
