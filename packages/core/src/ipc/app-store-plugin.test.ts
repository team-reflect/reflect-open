import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAppStoreEnvironment,
  presentOfferCodeRedeemSheet,
  syncAppStore,
} from './app-store-plugin'
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

  it('sync invokes the command with no arguments', async () => {
    const invoke = vi.fn().mockResolvedValue(null)
    setBridge({ invoke, listen: async () => () => {} })
    await expect(syncAppStore()).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('plugin:app-store|sync', {})
  })

  it('present_offer_code_redeem_sheet invokes the command with no arguments', async () => {
    const invoke = vi.fn().mockResolvedValue(null)
    setBridge({ invoke, listen: async () => () => {} })
    await expect(presentOfferCodeRedeemSheet()).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('plugin:app-store|present_offer_code_redeem_sheet', {})
  })
})
