import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapturedPost } from '@reflect/core/capture-envelope'
import { saveCapture } from '../save-capture'
import { handlePostCaptured } from './capture-post'
import { X_BOOKMARKS_KEY, X_LIKES_KEY } from './preferences'
import { seenKey } from './seen'

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
vi.mock('../save-capture', () => ({
  saveCapture: vi.fn(),
}))
vi.mock('../flush', () => ({
  flushQueue: vi.fn(),
}))

const saveMock = vi.mocked(saveCapture)

const POST: CapturedPost = {
  provider: 'x',
  id: '20',
  trigger: 'bookmark',
  author: { name: 'jack', handle: 'jack' },
  text: 'just setting up my twttr',
}

function page(post: CapturedPost = POST) {
  return { url: 'https://x.com/jack/status/20', title: '', post }
}

beforeEach(() => {
  store.clear()
  vi.clearAllMocks()
  saveMock.mockResolvedValue({ fate: 'queued' })
})

describe('handlePostCaptured', () => {
  it('does nothing while the feature is off', async () => {
    await expect(handlePostCaptured(page())).resolves.toEqual({ saved: false, reason: 'disabled' })
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('queues a bookmark once the feature is on and remembers it', async () => {
    store.set(X_BOOKMARKS_KEY, true)
    const now = new Date('2026-09-02T10:15:22.317Z')

    await expect(handlePostCaptured(page(), { now: () => now })).resolves.toEqual({
      saved: true,
      reason: 'queued',
    })

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://x.com/jack/status/20', post: POST, capturedAt: now }),
      expect.any(Function),
    )
    expect(store.has(seenKey('20'))).toBe(true)

    await expect(handlePostCaptured(page())).resolves.toEqual({ saved: false, reason: 'seen' })
    expect(saveMock).toHaveBeenCalledTimes(1)
  })

  it('ignores likes unless the likes switch is on', async () => {
    store.set(X_BOOKMARKS_KEY, true)
    const like = page({ ...POST, trigger: 'like' })
    await expect(handlePostCaptured(like)).resolves.toEqual({ saved: false, reason: 'disabled' })

    store.set(X_LIKES_KEY, true)
    await expect(handlePostCaptured(like)).resolves.toMatchObject({ saved: true })
  })

  it('forgets a post the host rejected, so a retry is possible', async () => {
    store.set(X_BOOKMARKS_KEY, true)
    saveMock.mockResolvedValue({ fate: 'rejected' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(handlePostCaptured(page())).resolves.toEqual({ saved: false, reason: 'rejected' })
    expect(store.has(seenKey('20'))).toBe(false)
    errorSpy.mockRestore()
  })

  it('forgets a post whose enqueue threw', async () => {
    store.set(X_BOOKMARKS_KEY, true)
    saveMock.mockRejectedValue(new Error('storage full'))

    await expect(handlePostCaptured(page())).rejects.toThrow('storage full')
    expect(store.has(seenKey('20'))).toBe(false)
  })
})
