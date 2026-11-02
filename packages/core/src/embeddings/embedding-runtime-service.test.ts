import { describe, expect, it, vi } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'

import { createEmbeddingRuntimeService, type EmbedStatus } from './embedding-runtime-service.ts'

const READY: EmbedStatus = { status: 'ready', model: 'all-MiniLM-L6-v2' }
const LOADING: EmbedStatus = { status: 'loading' }

function setup() {
  const ipc = createTestIpcBridgeService()
  const logger = createTestLoggerService()
  const runtime = createEmbeddingRuntimeService({ ipc, logger })
  return { ipc, logger, runtime }
}

describe('createEmbeddingRuntimeService', () => {
  it('polls, loads and embeds over the runtime commands', async () => {
    const { ipc, runtime } = setup()
    ipc.onCommand('embed_status', () => ({ status: 'uninitialized' }))
    ipc.onCommand('embed_ensure', () => READY)
    ipc.onCommand('embed_texts', () => [[0.5, 0.5]])

    await expect(runtime.refresh()).resolves.toEqual({ status: 'uninitialized' })
    await expect(runtime.ensure()).resolves.toEqual(READY)
    await expect(runtime.embedTexts(['hello'])).resolves.toEqual([[0.5, 0.5]])
    expect(ipc.calls().at(-1)).toEqual({ command: 'embed_texts', args: { texts: ['hello'] } })
  })

  it('remembers the last observed status and notifies subscribers', async () => {
    const { ipc, runtime } = setup()
    ipc.onCommand('embed_status', () => LOADING)
    expect(runtime.get()).toEqual({ status: 'uninitialized' })

    const seen: EmbedStatus[] = []
    const unlisten = runtime.subscribe(() => {
      seen.push(runtime.get())
    })
    await runtime.refresh()
    ipc.emit('embed:status', READY)
    unlisten()
    ipc.emit('embed:status', { status: 'failed', message: 'offline' })

    expect(seen).toEqual([LOADING, READY])
    expect(runtime.get()).toEqual(READY)
  })

  it('keeps the status when an observation repeats it', async () => {
    const { ipc, runtime } = setup()
    ipc.onCommand('embed_status', () => ({ ...READY }))
    const listener = vi.fn()
    runtime.subscribe(listener)

    await runtime.refresh()
    const first = runtime.get()
    await runtime.refresh()
    ipc.emit('embed:status', { ...READY })

    expect(runtime.get()).toBe(first)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('listens for status events only while subscribed', async () => {
    const { ipc, runtime } = setup()
    const stop = vi.fn()
    const listen = vi.spyOn(ipc, 'listen').mockResolvedValue(stop)

    const first = runtime.subscribe(() => {})
    const second = runtime.subscribe(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    first()
    first()
    expect(listen).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    second()

    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('polls once when the first subscriber starts the events', async () => {
    const { ipc, runtime } = setup()
    ipc.onCommand('embed_status', () => READY)
    const listener = vi.fn()

    const first = runtime.subscribe(listener)
    await vi.waitFor(() => expect(runtime.get()).toEqual(READY))
    const second = runtime.subscribe(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ipc.calls().filter((call) => call.command === 'embed_status')).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(1)
    first()
    second()
  })

  it('logs an invalid status event', () => {
    const { ipc, logger, runtime } = setup()
    runtime.subscribe(() => {})
    ipc.emit('embed:status', { status: 'mystery' })

    expect(runtime.get()).toEqual({ status: 'uninitialized' })
    expect(logger.getErrors()).toHaveLength(1)
  })

  it('logs a failed event subscription', async () => {
    const { ipc, logger } = setup()
    ipc.onCommand('embed_status', () => READY)
    vi.spyOn(ipc, 'listen').mockRejectedValue(new Error('no events'))
    const runtime = createEmbeddingRuntimeService({ ipc, logger })
    runtime.subscribe(() => {})
    await vi.waitFor(() => expect(runtime.get()).toEqual(READY))
    expect(logger.getWarnings()).toHaveLength(1)
  })

  describe('awaitTerminalStatus', () => {
    it('resolves a terminal status at once', async () => {
      const { runtime } = setup()
      await expect(runtime.awaitTerminalStatus({ status: 'unsupported' })).resolves.toEqual({
        status: 'unsupported',
      })
    })

    it('waits for a terminal event after a racing load', async () => {
      const { ipc, runtime } = setup()
      ipc.onCommand('embed_status', () => LOADING)

      const pending = runtime.awaitTerminalStatus(LOADING)
      await vi.waitFor(() => {
        expect(ipc.calls().map((call) => call.command)).toContain('embed_status')
      })
      ipc.emit('embed:status', READY)

      await expect(pending).resolves.toEqual(READY)
    })

    it('re-polls once the listener lands, in case the event already fired', async () => {
      const { ipc, runtime } = setup()
      ipc.onCommand('embed_status', () => READY)
      await expect(runtime.awaitTerminalStatus(LOADING)).resolves.toEqual(READY)
    })

    it('resolves when the re-poll answers the status already held', async () => {
      const { ipc, runtime } = setup()
      ipc.onCommand('embed_status', () => READY)
      await runtime.refresh()
      await expect(runtime.awaitTerminalStatus(LOADING)).resolves.toEqual(READY)
    })
  })

  describe('retry', () => {
    it('re-loads a failed model', async () => {
      const { ipc, runtime } = setup()
      ipc.onCommand('embed_status', () => ({ status: 'failed', message: 'offline' }))
      ipc.onCommand('embed_ensure', () => READY)

      await expect(runtime.retry()).resolves.toEqual(READY)
    })

    it('leaves any other status alone', async () => {
      const { ipc, runtime } = setup()
      ipc.onCommand('embed_status', () => READY)

      await expect(runtime.retry()).resolves.toEqual(READY)
      expect(ipc.calls().map((call) => call.command)).toEqual(['embed_status'])
    })

    it('resolves a throwing re-load as failed', async () => {
      const { ipc, runtime } = setup()
      ipc.onCommand('embed_status', () => ({ status: 'failed', message: 'offline' }))
      ipc.onCommand('embed_ensure', () => {
        throw new Error('no disk space')
      })

      await expect(runtime.retry()).resolves.toMatchObject({ status: 'failed' })
    })
  })
})
