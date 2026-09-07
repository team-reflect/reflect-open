import { beforeEach, expect, it, vi } from 'vitest'
import { buildWireMessage } from './capture-message'
import { sendToHost } from './native'

const { sendNativeMessage } = vi.hoisted(() => ({ sendNativeMessage: vi.fn() }))
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendNativeMessage } } }))

beforeEach(() => vi.clearAllMocks())

it('keeps v2 captures for an upgrade without treating malformed payloads as retryable', async () => {
  const wire = buildWireMessage({
    id: '00000000-0000-4000-8000-000000000001',
    capturedAt: new Date('2026-09-07T00:00:00Z'),
    url: 'https://x.com/i/status/123',
    title: 'Post',
    x: { day: '2026-09-07', trigger: 'manual', post: { id: '123' } },
  })
  sendNativeMessage.mockResolvedValueOnce({
    ok: false,
    code: 'invalid-payload',
    message: 'unsupported envelope version 2',
  })
  expect(await sendToHost(wire)).toMatchObject({ kind: 'held', reason: 'upgrade-required' })
  sendNativeMessage.mockResolvedValueOnce({
    ok: false,
    code: 'invalid-payload',
    message: 'post id does not match URL',
  })
  expect(await sendToHost(wire)).toMatchObject({ kind: 'rejected' })
})
