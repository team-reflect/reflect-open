import { describe, expect, it } from 'vitest'
import { createTestIpcBridgeService } from '@reflect/core/testing'
import { createDeferredIpcTransport } from '@/services/deferred-ipc.ts'

describe('createDeferredIpcTransport', () => {
  it('holds calls until a transport connects', async () => {
    const deferred = createDeferredIpcTransport()
    const pending = deferred.transport.invoke('app_version', {})
    deferred.connect(createTestIpcBridgeService({ commands: { app_version: () => '1' } }).transport)
    await expect(pending).resolves.toBe('1')
  })

  it('refuses a second transport', () => {
    const deferred = createDeferredIpcTransport()
    deferred.connect(createTestIpcBridgeService().transport)
    expect(() => deferred.connect(createTestIpcBridgeService().transport)).toThrow(
      /already connected/,
    )
  })

  it('forwards binary calls and file URLs to the connected transport', async () => {
    const deferred = createDeferredIpcTransport()
    const body = new Uint8Array([1])
    const binary = deferred.transport.invokeBinary?.('upload', body, { 'x-upload-id': 'u1' })
    deferred.connect(
      {
        ...createTestIpcBridgeService().transport,
        invokeBinary: (command, body, headers) => Promise.resolve({ command, body, headers }),
      },
      { convertFileSrc: (filePath, protocol) => `${protocol}:${filePath}` },
    )
    await expect(binary).resolves.toEqual({
      command: 'upload',
      body,
      headers: { 'x-upload-id': 'u1' },
    })
    expect(deferred.convertFileSrc('1/assets/cat.png', 'reflect-asset')).toBe(
      'reflect-asset:1/assets/cat.png',
    )
  })
})
