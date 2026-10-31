import { describe, expect, it } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createAppStoreService } from './app-store-service.ts'

describe('AppStoreService', () => {
  it('environment unwraps the environment field', async () => {
    const ipc = createTestIpcBridgeService()
    ipc.onCommand('plugin:app-store|get_environment', () => ({ environment: 'Sandbox' }))
    await expect(createAppStoreService({ ipc }).environment()).resolves.toBe('Sandbox')
    expect(ipc.calls()).toEqual([{ command: 'plugin:app-store|get_environment', args: {} }])
  })

  it('environment rejects when the probe cannot answer', async () => {
    const ipc = createTestIpcBridgeService()
    ipc.onCommand('plugin:app-store|get_environment', () => {
      throw new Error('no app transaction')
    })
    await expect(createAppStoreService({ ipc }).environment()).rejects.toMatchObject({
      kind: 'unknown',
    })
  })

  it('sync invokes the command with no arguments', async () => {
    const ipc = createTestIpcBridgeService()
    ipc.onCommand('plugin:app-store|sync', () => null)
    await expect(createAppStoreService({ ipc }).sync()).resolves.toBeUndefined()
    expect(ipc.calls()).toEqual([{ command: 'plugin:app-store|sync', args: {} }])
  })

  it('presentOfferCodeRedeemSheet invokes the command with no arguments', async () => {
    const ipc = createTestIpcBridgeService()
    ipc.onCommand('plugin:app-store|present_offer_code_redeem_sheet', () => null)
    await expect(
      createAppStoreService({ ipc }).presentOfferCodeRedeemSheet(),
    ).resolves.toBeUndefined()
    expect(ipc.calls()).toEqual([
      { command: 'plugin:app-store|present_offer_code_redeem_sheet', args: {} },
    ])
  })
})
