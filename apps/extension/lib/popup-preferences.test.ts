import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readIncludePageTextPreference, writeIncludePageTextPreference } from './popup-preferences'

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock('wxt/browser', async () => ({
  browser: {
    storage: { local: (await import('./test-utils/storage-mock')).createStorageLocalMock(store) },
  },
}))

const INCLUDE_PAGE_TEXT_KEY = 'preference:includePageText'

beforeEach(() => {
  store.clear()
})

describe('readIncludePageTextPreference', () => {
  it('defaults to false when the preference has not been saved', async () => {
    await expect(readIncludePageTextPreference()).resolves.toBe(false)
  })

  it('reads a saved true value', async () => {
    store.set(INCLUDE_PAGE_TEXT_KEY, true)

    await expect(readIncludePageTextPreference()).resolves.toBe(true)
  })

  it('falls back to false for corrupt stored values', async () => {
    store.set(INCLUDE_PAGE_TEXT_KEY, 'yes please')

    await expect(readIncludePageTextPreference()).resolves.toBe(false)
  })
})

describe('writeIncludePageTextPreference', () => {
  it('persists the latest checkbox value', async () => {
    await writeIncludePageTextPreference(true)
    expect(store.get(INCLUDE_PAGE_TEXT_KEY)).toBe(true)

    await writeIncludePageTextPreference(false)
    expect(store.get(INCLUDE_PAGE_TEXT_KEY)).toBe(false)
  })
})
