import { describe, expect, it, vi } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createNetworkService } from './network-service.ts'

describe('NetworkService', () => {
  it('follows the shell status and its changes', async () => {
    const ipc = createTestIpcBridgeService()
    ipc.onCommand('plugin:network|status', () => ({ expensive: true }))
    const network = createNetworkService({ ipc })
    expect(network.expensive.get()).toBe(false)

    const stop = network.watch()
    await vi.waitFor(() => expect(network.expensive.get()).toBe(true))

    ipc.emitPlugin('network', 'changed', { expensive: false })
    expect(network.expensive.get()).toBe(false)
    stop()
  })

  it('stays free where the shell has no network plugin', async () => {
    const ipc = createTestIpcBridgeService()
    const network = createNetworkService({ ipc })

    const stop = network.watch()
    await vi.waitFor(() => expect(ipc.calls()).toHaveLength(1))
    expect(network.expensive.get()).toBe(false)
    stop()
  })
})
