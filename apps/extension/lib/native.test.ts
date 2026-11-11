import { beforeEach, expect, it, vi } from 'vitest'
import { xPostWireSchema, type XPostKind } from '@reflect/core/capture-envelope'
import { sendToHost } from './native.ts'

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

it.each([
  'Specified native messaging host not found.',
  'Access to the specified native messaging host is forbidden.',
  'No such native application app.reflect.capture',
  'This extension does not have permission to use native application app.reflect.capture (or the application is not installed)',
])('holds as no-host when the browser cannot reach the host: %s', async (message) => {
  send.mockRejectedValueOnce(new Error(message))
  expect(await sendToHost(wire('x-bookmark'))).toMatchObject({ kind: 'held', reason: 'no-host' })
})

it('holds other native-messaging failures as io', async () => {
  send.mockRejectedValueOnce(new Error('An unexpected error occurred'))
  expect(await sendToHost(wire('x-bookmark'))).toMatchObject({ kind: 'held', reason: 'io' })
})
