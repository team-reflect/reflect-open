import { beforeEach, expect, it, vi } from 'vitest'
import { xPostWireSchema, type XPostKind } from '@reflect/core/capture-envelope'
import { sendToHost } from './native'

const { send } = vi.hoisted(() => ({
  send: vi.fn<(application: string, message: unknown) => Promise<unknown>>(),
}))
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendNativeMessage: send } } }))

function wire(kind: XPostKind) {
  return xPostWireSchema.parse({
    envelope: {
      version: 2,
      kind,
      id: '00000000-0000-4000-8000-000000000001',
      source: 'extension',
      postId: '20',
      capturedAt: '2026-09-09T04:00:00Z',
    },
  })
}
beforeEach(() => {
  vi.resetAllMocks()
})

it('holds a like the host cannot route until Reflect is updated', async () => {
  send.mockResolvedValueOnce({ ok: false, code: 'invalid-payload', message: 'Unexpected kind' })
  expect(await sendToHost(wire('x-like'))).toMatchObject({
    kind: 'held',
    reason: 'unsupported-version',
  })
  expect(send).toHaveBeenCalledTimes(1)
})

it('still drops a bookmark the host rejects', async () => {
  send.mockResolvedValueOnce({ ok: false, code: 'invalid-payload', message: 'bad capture' })
  expect(await sendToHost(wire('x-bookmark'))).toMatchObject({ kind: 'rejected' })
})
