import { beforeEach, expect, it, vi } from 'vitest'
import { saveXPost } from './x-save'
import { enqueueCapture, flushQueue } from './flush'

const { get, sendMessage } = vi.hoisted(() => ({ get: vi.fn(), sendMessage: vi.fn() }))
vi.mock('wxt/browser', () => ({ browser: { tabs: { get, sendMessage } } }))
vi.mock('./flush', () => ({ enqueueCapture: vi.fn(), flushQueue: vi.fn() }))
const pageUrl = 'https://x.com/home'
const post = { id: '123', createdAt: '', author: { name: '', handle: '' }, body: [] }
beforeEach(() => {
  vi.resetAllMocks()
  get.mockResolvedValue({ url: pageUrl, incognito: false })
  sendMessage.mockResolvedValue({ ok: true, pageUrl, post })
})

it('queues authenticated post data when the lookup succeeds', async () => {
  await saveXPost(1, '123')
  expect(enqueueCapture).toHaveBeenCalledWith({ envelope: expect.objectContaining({ data: post }) }, undefined)
  expect(flushQueue).toHaveBeenCalledOnce()
})

it.each(['not-observed', 'page-changed', 'timeout', 'missing-bridge', 'wrong-post'])(
  'preserves a URL-only bookmark when capture fails: %s',
  async (failure) => {
    if (failure === 'missing-bridge') sendMessage.mockRejectedValue(new Error('No receiver'))
    else if (failure === 'page-changed') {
      get.mockResolvedValueOnce({ url: pageUrl, incognito: false })
      get.mockResolvedValue({ url: 'https://x.com/other', incognito: false })
    } else if (failure === 'wrong-post') {
      sendMessage.mockResolvedValue({ ok: true, pageUrl, post: { ...post, id: '456' } })
    } else sendMessage.mockResolvedValue({ ok: false, reason: failure })
    await saveXPost(1, '123', '2026-09-14T00:00:00Z')
    expect(enqueueCapture).toHaveBeenCalledWith({
      envelope: {
        version: 2,
        kind: 'x-bookmark',
        source: 'extension',
        id: expect.any(String),
        capturedAt: '2026-09-14T00:00:00Z',
        postId: '123',
      },
    }, undefined)
    expect(flushQueue).toHaveBeenCalledOnce()
  },
)

it('still refuses incognito capture', async () => {
  get.mockResolvedValue({ url: pageUrl, incognito: true })
  await expect(saveXPost(1, '123')).rejects.toThrow('unsupported-tab')
  expect(enqueueCapture).not.toHaveBeenCalled()
})


it.each([true, false])('preserves the like kind with snapshot available=%s', async (available) => {
  if (!available) sendMessage.mockRejectedValue(new Error('No receiver'))
  const shouldAdmit = vi.fn(async () => true)
  await saveXPost(1, '123', '2026-09-14T00:00:00Z', { kind: 'x-like', shouldAdmit })
  expect(enqueueCapture).toHaveBeenCalledWith({ envelope: expect.objectContaining({
    kind: 'x-like', ...(available ? { data: post } : { postId: '123' }),
  }) }, shouldAdmit)
})
