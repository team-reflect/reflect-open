import type { MaybePromise } from '@reflect/utils'
import { describe, expect, it, vi } from 'vitest'
import { textCaptureEnvelopeSchema } from '../capture/capture-envelope.ts'
import type { Unlisten } from '../unlisten.ts'
import { createIndexQueryService } from '../indexing/index-query-service.ts'
import { createTestCaptureInboxService } from '../testing/capture.ts'
import { createTestClockService } from '../testing/clock.ts'
import { createNodeTestDatabaseService } from '../testing/database.ts'
import { createTestDeepLinkIntakeService, createTestDeepLinkSource } from '../testing/deep-link.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestProgressPort } from '../testing/ports.ts'
import type { DeepLinkIntakeServiceDeps } from './deep-link-intake-service.ts'

function setup(overrides?: Partial<DeepLinkIntakeServiceDeps>) {
  const progress = createTestProgressPort()
  const captureInbox = createTestCaptureInboxService()
  const indexQuery = createIndexQueryService({ database: createNodeTestDatabaseService() })
  const resolveNoteTarget = vi.spyOn(indexQuery, 'resolveNoteTarget')
  const graphSession = createTestGraphSessionService({ graph: { generation: 3 } })
  const service = createTestDeepLinkIntakeService({
    progress,
    captureInbox,
    indexQuery,
    graphSession,
    ...overrides,
  })
  const resolve = (url: string) => service.resolve(url)
  return { service, progress, captureInbox, resolveNoteTarget, graphSession, resolve }
}

describe('DeepLinkIntakeService.resolve', () => {
  it('answers self-contained places directly, with no status noise', async () => {
    const { resolve, resolveNoteTarget, progress } = setup()
    await expect(resolve('reflect://daily/2026-07-01')).resolves.toEqual({
      kind: 'daily',
      date: '2026-07-01',
    })
    expect(resolveNoteTarget).not.toHaveBeenCalled()
    expect(progress.getAll()).toEqual([])
  })

  it('resolves a note target to its path', async () => {
    const { resolve, resolveNoteTarget } = setup()
    resolveNoteTarget.mockResolvedValue('notes/project-x.md')

    await expect(resolve('reflect://note/Project%20X')).resolves.toEqual({
      kind: 'note',
      path: 'notes/project-x.md',
    })
    expect(resolveNoteTarget).toHaveBeenCalledWith('Project X')
  })

  it('surfaces a failure when the target resolves to nothing', async () => {
    const { resolve, resolveNoteTarget, progress } = setup()
    resolveNoteTarget.mockResolvedValue(null)

    await expect(resolve('reflect://note/ghost')).resolves.toEqual({ kind: 'none' })
    expect(progress.snapshot()).toMatchObject([
      { label: 'Opening link', status: 'failed', message: 'Note not found: ghost' },
    ])
  })

  it('surfaces a resolution failure instead of rejecting', async () => {
    const { resolve, resolveNoteTarget, progress } = setup()
    resolveNoteTarget.mockRejectedValue(new Error('index unavailable'))

    await expect(resolve('reflect://note/Project%20X')).resolves.toEqual({ kind: 'none' })
    expect(progress.snapshot()).toMatchObject([{ label: 'Opening link', status: 'failed' }])
  })

  it('drops a resolution failure that arrives after the link became stale', async () => {
    const { service, resolveNoteTarget, progress } = setup()
    let rejectResolve: (cause: Error) => void = () => {}
    resolveNoteTarget.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectResolve = reject
      }),
    )
    let stale = false
    const pending = service.resolve('reflect://note/Project%20X', { isStale: () => stale })

    stale = true
    rejectResolve(new Error('old index disappeared'))

    await expect(pending).resolves.toEqual({ kind: 'none' })
    expect(progress.getAll()).toEqual([])
  })

  it('drops a resolution that finished after the link became stale', async () => {
    const { service, resolveNoteTarget, progress } = setup()
    const pendingResolve = Promise.withResolvers<string>()
    resolveNoteTarget.mockReturnValue(pendingResolve.promise)
    let stale = false

    const pending = service.resolve('reflect://note/Project%20X', { isStale: () => stale })
    stale = true
    pendingResolve.resolve('notes/project-x.md')

    await expect(pending).resolves.toEqual({ kind: 'none' })
    expect(progress.getAll()).toEqual([])
  })

  it('surfaces a failure on a URL the grammar rejects', async () => {
    const { resolve, captureInbox, progress } = setup()
    await expect(resolve('reflect://edit-notes?content=evil')).resolves.toEqual({ kind: 'none' })

    expect(captureInbox.spooled()).toEqual([])
    expect(progress.snapshot()).toMatchObject([
      {
        label: 'Opening link',
        status: 'failed',
        message: 'Unrecognized link: reflect://edit-notes?content=evil',
      },
    ])
  })

  it('spools a valid text-capture envelope for an append link', async () => {
    const clock = createTestClockService({ now: Date.UTC(2026, 6, 1, 12) })
    const { resolve, captureInbox, progress } = setup({ clock })
    await expect(resolve('reflect://append?text=call%20the%20bank')).resolves.toEqual({
      kind: 'capture',
    })

    expect(captureInbox.spooled()).toHaveLength(1)
    const { name, json, generation } = captureInbox.spooled()[0]!
    const envelope = textCaptureEnvelopeSchema.parse(JSON.parse(json))
    expect(name).toBe(`${envelope.id}.json`)
    expect(envelope.kind).toBe('append')
    expect(envelope.text).toBe('call the bank')
    expect(envelope.capturedAt).toBe('2026-07-01T12:00:00.000Z')
    expect(generation).toBe(3)
    expect(progress.started()).toMatchObject([{ label: 'Added to today', ended: true }])
    expect(progress.getAll()).toEqual([])
  })

  it('spools into the given graph session', async () => {
    const { service, graphSession, captureInbox } = setup()
    const pinned = graphSession.getState().session
    graphSession.setGraph({ generation: 8 })

    await service.resolve('reflect://append?text=milk', { session: pinned })

    expect(captureInbox.spooled()[0]?.generation).toBe(3)
  })

  it('spools a task envelope for a task link', async () => {
    const { resolve, captureInbox, progress } = setup()
    await resolve('reflect://task?text=buy+milk')

    const { json } = captureInbox.spooled()[0]!
    const envelope = textCaptureEnvelopeSchema.parse(JSON.parse(json))
    expect(envelope.kind).toBe('task')
    expect(envelope.text).toBe('buy milk')
    expect(progress.started()).toMatchObject([{ label: 'Task added to today', ended: true }])
    expect(progress.getAll()).toEqual([])
  })

  it('spools a checkbox envelope for a checkbox link', async () => {
    const { resolve, captureInbox, progress } = setup()
    await resolve('reflect://checkbox?text=pack+a+bag')

    const { json } = captureInbox.spooled()[0]!
    const envelope = textCaptureEnvelopeSchema.parse(JSON.parse(json))
    expect(envelope.kind).toBe('checkbox')
    expect(envelope.text).toBe('pack a bag')
    expect(progress.started()).toMatchObject([{ label: 'Checkbox added to today', ended: true }])
    expect(progress.getAll()).toEqual([])
  })

  it('surfaces a capture with no graph open instead of spooling it', async () => {
    const { resolve, graphSession, captureInbox, progress } = setup()
    graphSession.setGraph(null)

    await expect(resolve('reflect://append?text=milk')).resolves.toEqual({ kind: 'none' })

    expect(captureInbox.spooled()).toEqual([])
    expect(progress.snapshot()).toMatchObject([
      { label: 'Saving capture', status: 'failed', message: 'No graph is open.' },
    ])
  })

  it('surfaces a spool failure instead of claiming success', async () => {
    const captureInbox = createTestCaptureInboxService()
    vi.spyOn(captureInbox, 'spool').mockRejectedValue(new Error('stale generation'))
    const { resolve, progress } = setup({ captureInbox })

    await expect(resolve('reflect://append?text=milk')).resolves.toEqual({ kind: 'none' })

    expect(progress.snapshot()).toMatchObject([{ label: 'Saving capture', status: 'failed' }])
  })
})

/**
 * A service over a source whose two calls are spies, so a case can count and fail them.
 */
function setupIntake() {
  const live = createTestDeepLinkSource()
  const onOpenUrl = vi.fn<(listener: (urls: string[]) => void) => MaybePromise<Unlisten>>(
    (listener) => live.onOpenUrl(listener),
  )
  const getCurrent = vi.fn<() => Promise<string[] | null>>(() => Promise.resolve(null))
  const service = createTestDeepLinkIntakeService({ source: { onOpenUrl, getCurrent } })
  /**
   * Deliver to the subscription made by the last `onOpenUrl` call.
   */
  const pluginDeliver = (urls: string[]): void => {
    const callback = onOpenUrl.mock.calls.at(-1)?.[0]
    if (callback === undefined) {
      throw new Error('onOpenUrl was never subscribed')
    }
    callback(urls)
  }
  return { service, onOpenUrl, getCurrent, pluginDeliver }
}

describe('DeepLinkIntakeService intake', () => {
  it('subscribes to the source exactly once for the app lifetime', async () => {
    const { service, onOpenUrl, getCurrent } = setupIntake()
    await service.startListener()
    await service.startListener()
    expect(onOpenUrl).toHaveBeenCalledTimes(1)
    expect(getCurrent).toHaveBeenCalledTimes(1)
  })

  it('buffers the launch URL from getCurrent — onOpenUrl does not replay it', async () => {
    const { service, getCurrent } = setupIntake()
    getCurrent.mockResolvedValue(['reflect://note/launch-target'])
    await service.startListener()

    const handler = vi.fn()
    service.onUrl(handler)

    expect(handler).toHaveBeenCalledWith('reflect://note/launch-target')
  })

  it('retries after a failed subscription instead of latching disabled', async () => {
    const { service, onOpenUrl } = setupIntake()
    onOpenUrl.mockRejectedValueOnce(new Error('plugin not ready'))

    await expect(service.startListener()).rejects.toThrow('plugin not ready')
    await service.startListener()

    expect(onOpenUrl).toHaveBeenCalledTimes(2)
  })

  it('unlatches even when the teardown itself throws, keeping the original error', async () => {
    const { service, onOpenUrl, getCurrent } = setupIntake()
    onOpenUrl.mockResolvedValueOnce(() => {
      throw new Error('unlisten blew up')
    })
    getCurrent.mockRejectedValueOnce(new Error('ipc failure'))

    await expect(service.startListener()).rejects.toThrow('ipc failure')

    await service.startListener()
    expect(onOpenUrl).toHaveBeenCalledTimes(2)
  })

  it('tears down the subscription when getCurrent fails, so a retry cannot double-deliver', async () => {
    const { service, onOpenUrl, getCurrent, pluginDeliver } = setupIntake()
    const unlisten = vi.fn()
    onOpenUrl.mockResolvedValue(unlisten)
    getCurrent.mockRejectedValueOnce(new Error('ipc failure'))

    await expect(service.startListener()).rejects.toThrow('ipc failure')
    expect(unlisten).toHaveBeenCalledTimes(1)

    await service.startListener()
    const handler = vi.fn()
    service.onUrl(handler)
    pluginDeliver(['reflect://today'])

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('delivers straight to a subscribed listener', async () => {
    const { service, pluginDeliver } = setupIntake()
    await service.startListener()
    const handler = vi.fn()
    service.onUrl(handler)

    pluginDeliver(['reflect://today'])

    expect(handler).toHaveBeenCalledWith('reflect://today')
  })

  it('buffers URLs that arrive with no listener and replays them in order on subscribe', async () => {
    const { service, pluginDeliver } = setupIntake()
    await service.startListener()
    pluginDeliver(['reflect://today', 'reflect://tasks'])

    const handler = vi.fn()
    service.onUrl(handler)

    expect(handler.mock.calls).toEqual([['reflect://today'], ['reflect://tasks']])
  })

  it('delivers an in-app dispatch (a clicked note link) straight to the listener', () => {
    const { service } = setupIntake()
    const handler = vi.fn()
    service.onUrl(handler)

    service.dispatch('reflect://note/from-a-note-body')

    expect(handler).toHaveBeenCalledWith('reflect://note/from-a-note-body')
  })

  it('buffers an in-app dispatch when no listener is subscribed', () => {
    const { service } = setupIntake()
    service.dispatch('reflect://today')

    const handler = vi.fn()
    service.onUrl(handler)

    expect(handler).toHaveBeenCalledWith('reflect://today')
  })

  it('buffers again after the listener unsubscribes (graph switch gap)', async () => {
    const { service, pluginDeliver } = setupIntake()
    await service.startListener()
    const first = vi.fn()
    const stop = service.onUrl(first)
    stop()

    pluginDeliver(['reflect://daily/2026-07-01'])
    expect(first).not.toHaveBeenCalled()

    const second = vi.fn()
    service.onUrl(second)
    expect(second).toHaveBeenCalledWith('reflect://daily/2026-07-01')
  })

  it('keeps the buffer of one service apart from another', () => {
    const first = createTestDeepLinkIntakeService()
    const second = createTestDeepLinkIntakeService()
    first.dispatch('reflect://today')

    const handler = vi.fn()
    second.onUrl(handler)

    expect(handler).not.toHaveBeenCalled()
  })

  it('delivers the launch URLs and later URLs of the test source', async () => {
    const source = createTestDeepLinkSource({ current: ['reflect://tasks'] })
    const service = createTestDeepLinkIntakeService({ source })
    const handler = vi.fn()
    service.onUrl(handler)

    await service.startListener()
    source.deliver(['reflect://today'])

    expect(source.subscriptionCount()).toBe(1)
    expect(handler.mock.calls).toEqual([['reflect://tasks'], ['reflect://today']])
    expect(service.dispatched()).toEqual([])
  })

  it('drains the buffer into the first listener only, then delivers to every listener', () => {
    const { service } = setupIntake()
    service.dispatch('reflect://today')
    const first = vi.fn()
    const second = vi.fn()
    service.onUrl(first)
    service.onUrl(second)

    service.dispatch('reflect://tasks')

    expect(first.mock.calls).toEqual([['reflect://today'], ['reflect://tasks']])
    expect(second.mock.calls).toEqual([['reflect://tasks']])
  })
})
