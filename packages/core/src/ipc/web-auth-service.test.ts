import { describe, expect, it } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createWebAuthService } from './web-auth-service.ts'

const options = {
  url: 'https://example.com/oauth?state=1',
  callbackScheme: 'example',
  ephemeral: false,
}

function serviceAnswering(response: unknown) {
  const ipc = createTestIpcBridgeService()
  ipc.onCommand('plugin:web-auth|start', () => response)
  return { ipc, webAuth: createWebAuthService({ ipc }) }
}

describe('WebAuthService', () => {
  it('start sends the options as the payload and returns the callback URL', async () => {
    const { ipc, webAuth } = serviceAnswering({ url: 'example://callback?code=abc' })
    await expect(webAuth.start(options)).resolves.toBe('example://callback?code=abc')
    expect(ipc.calls()).toEqual([{ command: 'plugin:web-auth|start', args: { payload: options } }])
  })

  it('start maps a missing URL to null', async () => {
    const { webAuth } = serviceAnswering({})
    await expect(webAuth.start(options)).resolves.toBeNull()
  })

  it('start maps a null URL to null', async () => {
    const { webAuth } = serviceAnswering({ url: null })
    await expect(webAuth.start(options)).resolves.toBeNull()
  })
})
