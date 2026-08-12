import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { isAppError } from '../errors'
import { setBridge } from './bridge'
import { definePluginCommand, definePluginEvent, ignoredResult } from './plugin'

afterEach(() => {
  setBridge(null)
})

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

describe('definePluginCommand', () => {
  it('composes the plugin command name and validates the response', async () => {
    const invoke = vi.fn().mockResolvedValue({ doubled: 4 })
    setBridge({ invoke, listen: async () => () => {} })

    await expect(doThing({ request: { value: 2 } })).resolves.toEqual({ doubled: 4 })
    expect(invoke).toHaveBeenCalledWith('plugin:demo|do_thing', { request: { value: 2 } })
  })

  it('passes any fire-and-forget acknowledgement through unvalidated', async () => {
    const invoke = vi.fn().mockResolvedValue(true)
    setBridge({ invoke, listen: async () => () => {} })

    await expect(fireAndForget({})).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('plugin:demo|fire_and_forget', {})
  })

  it('turns a mismatched response into a parse AppError naming the command', async () => {
    setBridge({ invoke: async () => ({ wrong: true }), listen: async () => () => {} })

    const error = await doThing({ request: { value: 2 } }).catch((caught: unknown) => caught)
    expect(isAppError(error)).toBe(true)
    if (isAppError(error)) {
      expect(error.kind).toBe('parse')
      expect(error.message).toContain('plugin:demo|do_thing')
    }
  })

  it('coerces a rejection into an AppError like call()', async () => {
    setBridge({
      invoke: async () => {
        throw 'microphone access denied'
      },
      listen: async () => () => {},
    })

    const error = await fireAndForget({}).catch((caught: unknown) => caught)
    expect(error).toEqual({ kind: 'unknown', message: 'microphone access denied' })
  })
})

describe('definePluginEvent', () => {
  const subscribeDemo = definePluginEvent('demo', 'demoEvent', z.object({ n: z.number() }))

  function bridgeWithPluginEvents() {
    const handlers = new Map<string, (payload: unknown) => void>()
    const listenPlugin = vi.fn(
      async (plugin: string, event: string, handler: (payload: unknown) => void) => {
        handlers.set(`${plugin}:${event}`, handler)
      },
    )
    setBridge({ invoke: async () => null, listen: async () => () => {}, listenPlugin })
    return { handlers, listenPlugin }
  }

  it('delivers validated payloads and drops malformed ones', async () => {
    const { handlers } = bridgeWithPluginEvents()
    const seen: number[] = []
    const subscription = subscribeDemo((payload) => {
      seen.push(payload.n)
    })
    await subscription.ready

    handlers.get('demo:demoEvent')?.({ n: 1 })
    handlers.get('demo:demoEvent')?.({ bogus: true })
    handlers.get('demo:demoEvent')?.({ n: 2 })
    expect(seen).toEqual([1, 2])
  })

  it('shares one native registration and detaches subscribers locally', async () => {
    const { handlers, listenPlugin } = bridgeWithPluginEvents()
    const first: number[] = []
    const second: number[] = []
    const one = subscribeDemo((payload) => {
      first.push(payload.n)
    })
    const two = subscribeDemo((payload) => {
      second.push(payload.n)
    })
    await Promise.all([one.ready, two.ready])
    expect(listenPlugin).toHaveBeenCalledTimes(1)

    handlers.get('demo:demoEvent')?.({ n: 1 })
    one.unlisten()
    handlers.get('demo:demoEvent')?.({ n: 2 })
    expect(first).toEqual([1])
    expect(second).toEqual([1, 2])
  })

  it('an unlisten before registration resolves suppresses delivery', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const handlers = new Map<string, (payload: unknown) => void>()
    setBridge({
      invoke: async () => null,
      listen: async () => () => {},
      listenPlugin: async (plugin, event, handler) => {
        await gate
        handlers.set(`${plugin}:${event}`, handler)
      },
    })

    const seen: number[] = []
    const subscription = subscribeDemo((payload) => {
      seen.push(payload.n)
    })
    subscription.unlisten()
    release()
    await subscription.ready
    handlers.get('demo:demoEvent')?.({ n: 3 })
    expect(seen).toEqual([])
  })

  it('a failed registration is retried by the next subscriber', async () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    const listenPlugin = vi
      .fn(async (plugin: string, event: string, handler: (payload: unknown) => void) => {
        handlers.set(`${plugin}:${event}`, handler)
      })
      .mockRejectedValueOnce(new Error('webview teardown'))
    setBridge({ invoke: async () => null, listen: async () => () => {}, listenPlugin })

    await expect(subscribeDemo(() => {}).ready).rejects.toThrow('webview teardown')

    const seen: number[] = []
    const subscription = subscribeDemo((payload) => {
      seen.push(payload.n)
    })
    await subscription.ready
    handlers.get('demo:demoEvent')?.({ n: 5 })
    expect(seen).toEqual([5])
    expect(listenPlugin).toHaveBeenCalledTimes(2)
  })

  it('ready rejects loudly when the bridge has no plugin events', async () => {
    setBridge({ invoke: async () => null, listen: async () => () => {} })

    const subscription = subscribeDemo(() => {})
    await expect(subscription.ready).rejects.toMatchObject({ kind: 'io' })
  })
})
