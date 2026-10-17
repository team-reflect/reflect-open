import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AppError, isAppError } from '../errors.ts'
import { createIpcBridgeService, listenNow, type IpcBridge } from './ipc-service.ts'

function createLogger() {
  return {
    error: vi.fn<(message: string, cause?: unknown) => void>(),
    warn: vi.fn<(message: string, cause?: unknown) => void>(),
    info: vi.fn<(message: string, cause?: unknown) => void>(),
  }
}

function serviceOver(transport: IpcBridge) {
  const logger = createLogger()
  return { ipc: createIpcBridgeService({ transport, logger }), logger }
}

describe('call', () => {
  it('returns the schema-validated response', async () => {
    const invoke = vi.fn().mockResolvedValue({ root: '/g', generation: 1 })
    const { ipc } = serviceOver({ invoke, listen: async () => () => {} })

    const schema = z.object({ root: z.string(), generation: z.number() })
    await expect(ipc.call('graph_open', { path: '/g' }, schema)).resolves.toEqual({
      root: '/g',
      generation: 1,
    })
    expect(invoke).toHaveBeenCalledWith('graph_open', { path: '/g' })
  })

  it('passes a well-formed Rust error through as an AppError', async () => {
    const { ipc } = serviceOver({
      invoke: async () => {
        const rustError: unknown = { kind: 'notFound', message: 'missing' }
        throw rustError
      },
      listen: async () => () => {},
    })

    const error = await ipc
      .call('note_read', { path: 'x' }, z.string())
      .catch((caught: unknown) => caught)
    expect(isAppError(error)).toBe(true)
    expect(error).toEqual(new AppError('notFound', 'missing'))
  })

  it('coerces a foreign rejection into an unknown AppError', async () => {
    const { ipc } = serviceOver({
      invoke: async () => {
        throw new Error('socket closed')
      },
      listen: async () => () => {},
    })

    const error = await ipc
      .call('note_read', { path: 'x' }, z.string())
      .catch((caught: unknown) => caught)
    expect(error).toEqual(new AppError('unknown', 'socket closed'))
  })

  it('turns a response that fails validation into a parse error naming the command', async () => {
    const { ipc } = serviceOver({
      invoke: async () => ({ wrong: true }),
      listen: async () => () => {},
    })

    const error = await ipc.call('graph_open', {}, z.string()).catch((caught: unknown) => caught)
    expect(isAppError(error)).toBe(true)
    if (isAppError(error)) {
      expect(error.kind).toBe('parse')
      expect(error.message).toContain('graph_open')
    }
  })
})

describe('callBinary', () => {
  it('sends the raw body and headers and validates the response', async () => {
    const invokeBinary = vi.fn().mockResolvedValue({ written: 3 })
    const { ipc } = serviceOver({
      invoke: async () => null,
      listen: async () => () => {},
      invokeBinary,
    })

    const body = new Uint8Array([1, 2, 3])
    await expect(
      ipc.callBinary('asset_write', body, { path: 'a.png' }, z.object({ written: z.number() })),
    ).resolves.toEqual({ written: 3 })
    expect(invokeBinary).toHaveBeenCalledWith('asset_write', body, { path: 'a.png' })
    expect(ipc.hasBinaryTransport).toBe(true)
  })

  it('rejects with an io AppError when the transport has no binary path', async () => {
    const { ipc } = serviceOver({ invoke: async () => null, listen: async () => () => {} })

    expect(ipc.hasBinaryTransport).toBe(false)
    await expect(
      ipc.callBinary('asset_write', new Uint8Array(), {}, z.unknown()),
    ).rejects.toMatchObject({ kind: 'io' })
  })
})

describe('listen', () => {
  it('forwards to the transport', async () => {
    const unlisten = vi.fn()
    const listen = vi.fn().mockResolvedValue(unlisten)
    const { ipc } = serviceOver({ invoke: async () => null, listen })
    const handler = (): void => {}

    await expect(ipc.listen('fs:changed', handler)).resolves.toBe(unlisten)
    expect(listen).toHaveBeenCalledWith('fs:changed', handler)
  })
})

describe('listenPlugin', () => {
  it('rejects with an io AppError when the transport has no plugin events', async () => {
    const { ipc } = serviceOver({ invoke: async () => null, listen: async () => () => {} })

    await expect(ipc.listenPlugin('demo', 'demoEvent', () => {})).rejects.toMatchObject({
      kind: 'io',
    })
  })
})

describe('subscribePlugin', () => {
  const schema = z.object({ n: z.number() })

  function serviceWithPluginEvents() {
    const handlers = new Map<string, (payload: unknown) => void>()
    const listenPlugin = vi.fn(
      async (plugin: string, event: string, handler: (payload: unknown) => void) => {
        handlers.set(`${plugin}:${event}`, handler)
      },
    )
    const { ipc, logger } = serviceOver({
      invoke: async () => null,
      listen: async () => () => {},
      listenPlugin,
    })
    return { ipc, logger, handlers, listenPlugin }
  }

  it('delivers validated payloads and drops malformed ones with a warning', async () => {
    const { ipc, logger, handlers } = serviceWithPluginEvents()
    const seen: number[] = []
    const subscription = ipc.subscribePlugin('demo', 'demoEvent', schema, (payload) => {
      seen.push(payload.n)
    })
    await subscription.ready

    handlers.get('demo:demoEvent')?.({ n: 1 })
    handlers.get('demo:demoEvent')?.({ bogus: true })
    handlers.get('demo:demoEvent')?.({ n: 2 })
    expect(seen).toEqual([1, 2])
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]?.[0]).toContain('demo:demoEvent')
  })

  it('shares one native registration and detaches subscribers locally', async () => {
    const { ipc, handlers, listenPlugin } = serviceWithPluginEvents()
    const first: number[] = []
    const second: number[] = []
    const one = ipc.subscribePlugin('demo', 'demoEvent', schema, (payload) => {
      first.push(payload.n)
    })
    const two = ipc.subscribePlugin('demo', 'demoEvent', schema, (payload) => {
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

  it('keeps registrations per service instance', async () => {
    const a = serviceWithPluginEvents()
    const b = serviceWithPluginEvents()
    await a.ipc.subscribePlugin('demo', 'demoEvent', schema, () => {}).ready
    await b.ipc.subscribePlugin('demo', 'demoEvent', schema, () => {}).ready
    expect(a.listenPlugin).toHaveBeenCalledTimes(1)
    expect(b.listenPlugin).toHaveBeenCalledTimes(1)
  })

  it('an unlisten before registration resolves suppresses delivery', async () => {
    const gate = Promise.withResolvers<void>()
    const handlers = new Map<string, (payload: unknown) => void>()
    const { ipc } = serviceOver({
      invoke: async () => null,
      listen: async () => () => {},
      listenPlugin: async (plugin, event, handler) => {
        await gate.promise
        handlers.set(`${plugin}:${event}`, handler)
      },
    })

    const seen: number[] = []
    const subscription = ipc.subscribePlugin('demo', 'demoEvent', schema, (payload) => {
      seen.push(payload.n)
    })
    subscription.unlisten()
    gate.resolve()
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
    const { ipc } = serviceOver({
      invoke: async () => null,
      listen: async () => () => {},
      listenPlugin,
    })

    await expect(ipc.subscribePlugin('demo', 'demoEvent', schema, () => {}).ready).rejects.toThrow(
      'webview teardown',
    )

    const seen: number[] = []
    const subscription = ipc.subscribePlugin('demo', 'demoEvent', schema, (payload) => {
      seen.push(payload.n)
    })
    await subscription.ready
    handlers.get('demo:demoEvent')?.({ n: 5 })
    expect(seen).toEqual([5])
    expect(listenPlugin).toHaveBeenCalledTimes(2)
  })

  it('ready rejects loudly when the transport has no plugin events', async () => {
    const { ipc } = serviceOver({ invoke: async () => null, listen: async () => () => {} })

    const subscription = ipc.subscribePlugin('demo', 'demoEvent', schema, () => {})
    await expect(subscription.ready).rejects.toMatchObject({ kind: 'io' })
  })
})

describe('listenNow', () => {
  it('returns a teardown before the registration lands and applies it afterwards', async () => {
    const registration = Promise.withResolvers<() => void>()
    const unlisten = vi.fn()
    const onError = vi.fn()

    const teardown = listenNow(() => registration.promise, onError)
    teardown()
    registration.resolve(unlisten)
    await registration.promise
    await Promise.resolve()

    expect(unlisten).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })

  it('tears down a landed registration', async () => {
    const unlisten = vi.fn()
    const teardown = listenNow(async () => unlisten, vi.fn())
    await Promise.resolve()
    await Promise.resolve()

    teardown()
    teardown()

    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('accepts a registration that returns its teardown synchronously', async () => {
    const unlisten = vi.fn()
    const teardown = listenNow(() => unlisten, vi.fn())
    await Promise.resolve()

    teardown()

    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('reports synchronous and asynchronous registration failures', async () => {
    const onError = vi.fn()
    listenNow(() => {
      throw new Error('no bridge')
    }, onError)
    listenNow(async () => {
      throw new Error('denied')
    }, onError)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2))
    expect(onError).toHaveBeenCalledWith(new AppError('unknown', 'no bridge'))
    expect(onError).toHaveBeenCalledWith(new AppError('unknown', 'denied'))
  })
})
