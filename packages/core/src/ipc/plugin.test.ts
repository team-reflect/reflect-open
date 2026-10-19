import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AppError, isAppError } from '../errors.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createIpcBridgeService, type IpcBridge } from './ipc-service.ts'
import { definePluginCommand, definePluginEvent, ignoredResult } from './plugin.ts'

const doThing = definePluginCommand<{ request: { value: number } }, { doubled: number }>(
  'demo',
  'do_thing',
  z.object({ doubled: z.number() }),
)
const fireAndForget = definePluginCommand<Record<string, never>, unknown>(
  'demo',
  'fire_and_forget',
  ignoredResult,
)

function serviceOver(transport: IpcBridge) {
  return createIpcBridgeService({ transport, logger: createTestLoggerService() })
}

describe('definePluginCommand', () => {
  it('composes the plugin command name and validates the response', async () => {
    const invoke = vi.fn().mockResolvedValue({ doubled: 4 })
    const ipc = serviceOver({ invoke, listen: () => Promise.resolve(() => {}) })

    await expect(doThing(ipc, { request: { value: 2 } })).resolves.toEqual({ doubled: 4 })
    expect(invoke).toHaveBeenCalledWith('plugin:demo|do_thing', { request: { value: 2 } })
  })

  it('passes any fire-and-forget acknowledgement through unvalidated', async () => {
    const invoke = vi.fn().mockResolvedValue(true)
    const ipc = serviceOver({ invoke, listen: () => Promise.resolve(() => {}) })

    await expect(fireAndForget(ipc, {})).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('plugin:demo|fire_and_forget', {})
  })

  it('turns a mismatched response into a parse AppError naming the command', async () => {
    const ipc = serviceOver({
      invoke: () => Promise.resolve({ wrong: true }),
      listen: () => Promise.resolve(() => {}),
    })

    const error = await doThing(ipc, { request: { value: 2 } }).catch((caught: unknown) => caught)
    expect(isAppError(error)).toBe(true)
    if (isAppError(error)) {
      expect(error.kind).toBe('parse')
      expect(error.message).toContain('plugin:demo|do_thing')
    }
  })

  it('coerces a rejection into an AppError like call()', async () => {
    const ipc = serviceOver({
      invoke: () => {
        return Promise.try(() => {
          const rejection: unknown = 'microphone access denied'
          throw rejection
        })
      },
      listen: () => Promise.resolve(() => {}),
    })

    const error = await fireAndForget(ipc, {}).catch((caught: unknown) => caught)
    expect(error).toEqual(new AppError('unknown', 'microphone access denied'))
  })
})

describe('definePluginEvent', () => {
  const subscribeDemo = definePluginEvent('demo', 'demoEvent', z.object({ n: z.number() }))

  it('subscribes through the given service with the declared schema', async () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    const ipc = serviceOver({
      invoke: () => Promise.resolve(null),
      listen: () => Promise.resolve(() => {}),
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
