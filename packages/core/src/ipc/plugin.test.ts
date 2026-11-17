import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestLoggerService } from '../testing/logger.ts'
import { createIpcBridgeService, type IpcBridge } from './ipc-service.ts'
import { definePluginEvent } from './plugin.ts'
import { noop } from '@ocavue/utils'

function serviceOver(transport: IpcBridge) {
  return createIpcBridgeService({ transport, logger: createTestLoggerService() })
}

describe('definePluginEvent', () => {
  const subscribeDemo = definePluginEvent('demo', 'demoEvent', z.object({ n: z.number() }))

  it('subscribes through the given service with the declared schema', async () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    const ipc = serviceOver({
      invoke: () => Promise.resolve(null),
      listen: () => Promise.resolve(noop),
      listenPlugin: (plugin, event, handler) => {
        handlers.set(`${plugin}:${event}`, handler)
        return Promise.resolve()
      },
    })
    const seen: number[] = []
    const subscription = subscribeDemo(ipc, (payload) => {
      seen.push(payload.n)
    })
    await subscription.ready

    handlers.get('demo:demoEvent')?.({ n: 1 })
    handlers.get('demo:demoEvent')?.({ bogus: true })
    subscription.unlisten()
    handlers.get('demo:demoEvent')?.({ n: 2 })
    expect(seen).toEqual([1])
  })
})
