import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAppStoreEnvironment } from './app-store-plugin'
import { setBridge } from './bridge'

afterEach(() => {
  setBridge(null)
})

describe('app-store plugin bindings', () => {
  it('get_environment unwraps the environment field', async () => {
    const invoke = vi.fn().mockResolvedValue({ environment: 'Sandbox' })
    setBridge({ invoke, listen: async () => () => {} })
    await expect(getAppStoreEnvironment()).resolves.toBe('Sandbox')
    expect(invoke).toHaveBeenCalledWith('plugin:app-store|get_environment', {})
  })
})
