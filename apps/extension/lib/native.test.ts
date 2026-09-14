import { beforeEach, expect, it, vi } from 'vitest'
import { browser } from 'wxt/browser'
import { likeWireSchema } from '@reflect/core/capture-envelope'
import { sendToHost } from './native'

vi.mock('wxt/browser', () => ({ browser: { runtime: { sendNativeMessage: vi.fn() } } }))
const send = vi.mocked(browser.runtime.sendNativeMessage)
const wire = likeWireSchema.parse({
  envelope: {
    version: 2,
    kind: 'x-like',
    id: '00000000-0000-4000-8000-000000000001',
    source: 'extension',
    postId: '20',
    capturedAt: '2026-09-09T04:00:00Z',
  },
})
const supported = { ok: true, status: 'capabilities', xLikeVersion: 2 }
beforeEach(() => {
  vi.resetAllMocks()
})

it.each([
  { ok: false, code: 'invalid-payload', message: 'Unexpected capture JSON' },
  { ok: true, status: 'capabilities', xLikeVersion: null },
])('keeps likes without transmitting them to an unsupported reader', async (reply) => {
  send.mockResolvedValueOnce(reply)
  expect(await sendToHost(wire)).toMatchObject({ kind: 'held', reason: 'unsupported-version' })
  expect(send).toHaveBeenCalledTimes(1)
  expect(send.mock.calls[0]?.[1]).toEqual({ type: 'capture-capabilities' })
})

it('requires a fresh capability probe on every delivery', async () => {
  send.mockResolvedValueOnce(supported).mockResolvedValueOnce({ ok: true, status: 'queued' })
  expect(await sendToHost(wire)).toEqual({ kind: 'queued' })
  send.mockResolvedValueOnce({ ...supported, xLikeVersion: null })
  expect(await sendToHost(wire)).toMatchObject({ kind: 'held', reason: 'unsupported-version' })
  expect(send).toHaveBeenCalledTimes(3)
})

it.each(['invalid-payload', 'unsupported-version'])(
  'retains a like if support changes after the probe: %s',
  async (code) => {
    send
      .mockResolvedValueOnce(supported)
      .mockResolvedValueOnce({ ok: false, code, message: 'changed reader' })
    expect(await sendToHost(wire)).toMatchObject({ kind: 'held' })
  },
)

it('holds malformed probe responses and missing hosts', async () => {
  send.mockResolvedValueOnce({ surprise: true })
  expect(await sendToHost(wire)).toMatchObject({ kind: 'held', reason: 'io' })
  send.mockRejectedValueOnce(new Error('host not found'))
  expect(await sendToHost(wire)).toMatchObject({ kind: 'held', reason: 'no-host' })
})

it('does not probe or change rejection policy for bookmarks', async () => {
  send.mockResolvedValueOnce({ ok: false, code: 'invalid-payload', message: 'bad capture' })
  expect(await sendToHost({ envelope: { ...wire.envelope, kind: 'x-bookmark' } })).toMatchObject({
    kind: 'rejected',
  })
  expect(send).toHaveBeenCalledTimes(1)
})
