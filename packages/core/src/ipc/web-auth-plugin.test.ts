import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from './bridge.ts'
import { startWebAuth } from './web-auth-plugin.ts'

const options = {
  url: 'https://example.com/oauth?state=1',
  callbackScheme: 'example',
  ephemeral: false,
}

afterEach(() => {
  setBridge(null)
})

describe('web-auth plugin bindings', () => {
  it('start sends the options as the payload and returns the callback URL', async () => {
    const invoke = vi.fn().mockResolvedValue({ url: 'example://callback?code=abc' })
    setBridge({ invoke, listen: async () => () => {} })
    await expect(startWebAuth(options)).resolves.toBe('example://callback?code=abc')
    expect(invoke).toHaveBeenCalledWith('plugin:web-auth|start', { payload: options })
  })

  it('start maps a missing URL to null', async () => {
    const invoke = vi.fn().mockResolvedValue({})
    setBridge({ invoke, listen: async () => () => {} })
    await expect(startWebAuth(options)).resolves.toBeNull()
  })

  it('start maps a null URL to null', async () => {
    const invoke = vi.fn().mockResolvedValue({ url: null })
    setBridge({ invoke, listen: async () => () => {} })
    await expect(startWebAuth(options)).resolves.toBeNull()
  })
})
