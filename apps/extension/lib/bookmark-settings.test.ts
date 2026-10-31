import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readBookmarkSettings, writeBookmarkSettings } from './bookmark-settings.ts'
import { readLikeSettings, writeLikeSettings } from './like-settings.ts'

const store = new Map<string, unknown>()

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: (key: string) => Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
        set: (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            store.set(key, value)
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

describe('readBookmarkSettings', () => {
  it('is on when nothing has been saved', async () => {
    await expect(readBookmarkSettings()).resolves.toEqual({ enabled: true })
  })

  it('reads a saved opt-out', async () => {
    store.set('bookmarkSettings', { enabled: false })
    await expect(readBookmarkSettings()).resolves.toEqual({ enabled: false })
  })

  it('falls back to on for corrupt stored values', async () => {
    store.set('bookmarkSettings', 'off')
    await expect(readBookmarkSettings()).resolves.toEqual({ enabled: true })
  })
})

describe('writeBookmarkSettings', () => {
  it('persists the latest switch value', async () => {
    await writeBookmarkSettings({ enabled: false })
    expect(store.get('bookmarkSettings')).toEqual({ enabled: false })
    await writeBookmarkSettings({ enabled: true })
    expect(store.get('bookmarkSettings')).toEqual({ enabled: true })
  })
})

describe('like settings', () => {
  it('defaults missing or malformed likes to off without altering bookmarks', async () => {
    await expect(readLikeSettings()).resolves.toEqual({ enabled: false })
    store.set('xLikeSettings', { enabled: 'yes' })
    await expect(readLikeSettings()).resolves.toEqual({ enabled: false })
    await expect(readBookmarkSettings()).resolves.toEqual({ enabled: true })
  })

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('persists independent bookmark=%s and like=%s settings', async (bookmarks, likes) => {
    await writeBookmarkSettings({ enabled: bookmarks })
    await writeLikeSettings({ enabled: likes })
    expect(await readBookmarkSettings()).toEqual({ enabled: bookmarks })
    expect(await readLikeSettings()).toEqual({ enabled: likes })
  })
})
