import { describe, expect, it, vi } from 'vitest'
import type { CaptureInboxService } from '@reflect/core'
import {
  createTestCaptureInboxService,
  createTestCoreServices,
  createTestDeepLinkIntakeService,
  createTestGraphSessionService,
  createTestLoggerService,
  createTestProgressPort,
} from '@reflect/core/testing'
import { createDeepLinkRouter, type DeepLinkSession } from './deep-link-router.ts'
import type { Route } from './route.ts'

interface SetupOverrides {
  captureInbox?: CaptureInboxService
}

function setup(overrides?: SetupOverrides) {
  const operations = createTestProgressPort()
  const captureInbox = createTestCaptureInboxService()
  const logger = createTestLoggerService()
  const { indexQuery } = createTestCoreServices()
  const resolveNoteTarget = vi.spyOn(indexQuery, 'resolveNoteTarget')
  const navigate = vi.fn<(route: Route) => void>()
  const graphSession = createTestGraphSessionService({ graph: { generation: 3 } })
  const intake = createTestDeepLinkIntakeService({
    progress: operations,
    captureInbox: overrides?.captureInbox ?? captureInbox,
    indexQuery,
    graphSession,
  })
  const service = createDeepLinkRouter({ intake, logger, graphSession })
  const handle = (url: string) => service.handle(url, { navigate })
  return {
    service,
    intake,
    operations,
    captureInbox,
    logger,
    resolveNoteTarget,
    navigate,
    graphSession,
    handle,
  }
}

describe('DeepLinkRouter.handle', () => {
  it('navigates self-contained routes before resolving, with no status noise', () => {
    const { handle, navigate, resolveNoteTarget, operations } = setup()
    void handle('reflect://daily/2026-07-01')
    expect(navigate).toHaveBeenCalledWith({ kind: 'daily', date: '2026-07-01' })
    expect(resolveNoteTarget).not.toHaveBeenCalled()
    expect(operations.getAll()).toEqual([])
  })

  it('resolves a note target and navigates to its route', async () => {
    const { handle, navigate, resolveNoteTarget } = setup()
    resolveNoteTarget.mockResolvedValue('notes/project-x.md')

    await handle('reflect://note/Project%20X')

    expect(resolveNoteTarget).toHaveBeenCalledWith('Project X')
    expect(navigate).toHaveBeenCalledWith({ kind: 'note', path: 'notes/project-x.md' })
  })

  it('routes a daily-path resolution to the daily view', async () => {
    const { handle, navigate, resolveNoteTarget } = setup()
    resolveNoteTarget.mockResolvedValue('daily/2026-07-01.md')

    await handle('reflect://note/2026-07-01')

    expect(navigate).toHaveBeenCalledWith({ kind: 'daily', date: '2026-07-01' })
  })

  it('does not navigate when the target resolves to nothing', async () => {
    const { handle, navigate, resolveNoteTarget, operations } = setup()
    resolveNoteTarget.mockResolvedValue(null)

    await handle('reflect://note/ghost')

    expect(navigate).not.toHaveBeenCalled()
    expect(operations.snapshot()).toMatchObject([{ label: 'Opening link', status: 'failed' }])
  })

  it('drops a resolution that finished after the link became stale', async () => {
    const { service, navigate, resolveNoteTarget, operations } = setup()
    const pendingResolve = Promise.withResolvers<string>()
    resolveNoteTarget.mockReturnValue(pendingResolve.promise)
    let stale = false

    const pending = service.handle('reflect://note/Project%20X', {
      navigate,
      isStale: () => stale,
    })
    stale = true
    pendingResolve.resolve('notes/project-x.md')
    await pending

    expect(navigate).not.toHaveBeenCalled()
    expect(operations.getAll()).toEqual([])
  })

  it('spools a capture link without navigating', async () => {
    const { handle, navigate, captureInbox } = setup()
    await handle('reflect://append?text=milk')

    expect(captureInbox.spooled()).toHaveLength(1)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('forwards a dispatch to the intake', () => {
    const { service, intake } = setup()
    service.dispatch('reflect://today')
    expect(intake.dispatched()).toEqual(['reflect://today'])
  })
})

describe('DeepLinkRouter.serve', () => {
  function serveSession(overrides?: SetupOverrides) {
    const context = setup(overrides)
    context.graphSession.setGraph({ generation: 7 })
    const probes: { stale: boolean }[] = []
    const session: DeepLinkSession = {
      navigate: context.navigate,
      beginNavigationIntent: () => {
        const probe = { stale: false }
        probes.push(probe)
        return () => probe.stale
      },
    }
    const stop = context.service.serve(session)
    return { ...context, probes, stop }
  }

  it('acts on dispatched URLs until stopped, then buffers for the next session', () => {
    const { service, intake, navigate, stop } = serveSession()

    service.dispatch('reflect://today')
    expect(navigate).toHaveBeenCalledWith({ kind: 'today' })

    stop()
    service.dispatch('reflect://tasks')
    expect(navigate).toHaveBeenCalledTimes(1)

    const next = vi.fn()
    intake.onUrl(next)
    expect(next).toHaveBeenCalledWith('reflect://tasks')
  })

  it('drains the URLs that arrived before the session', () => {
    const context = setup()
    context.service.dispatch('reflect://tasks')

    context.service.serve({
      navigate: context.navigate,
      beginNavigationIntent: () => () => false,
    })

    expect(context.navigate).toHaveBeenCalledWith({ kind: 'tasks' })
  })

  it('pins a capture to the graph session open when serving started', async () => {
    const { service, graphSession, captureInbox } = serveSession()
    graphSession.setGraph({ generation: 8 })

    service.dispatch('reflect://append?text=milk')

    await vi.waitFor(() => expect(captureInbox.spooled()).toHaveLength(1))
    expect(captureInbox.spooled()[0]?.generation).toBe(7)
  })

  it('drops a note resolution whose navigation intent went stale', async () => {
    const { service, navigate, resolveNoteTarget, operations, probes } = serveSession()
    const pendingResolve = Promise.withResolvers<string>()
    resolveNoteTarget.mockReturnValue(pendingResolve.promise)

    service.dispatch('reflect://note/x')
    expect(probes).toHaveLength(1)
    probes[0]!.stale = true
    pendingResolve.resolve('notes/x.md')
    await Promise.resolve()
    await Promise.resolve()

    expect(navigate).not.toHaveBeenCalled()
    expect(operations.getAll()).toEqual([])
  })

  it('drops a note resolution that finished after the graph session ended', async () => {
    const { service, navigate, resolveNoteTarget, graphSession, operations } = serveSession()
    const pendingResolve = Promise.withResolvers<string>()
    resolveNoteTarget.mockReturnValue(pendingResolve.promise)

    service.dispatch('reflect://note/x')
    graphSession.setGraph({ generation: 8 })
    pendingResolve.resolve('notes/x.md')
    await Promise.resolve()
    await Promise.resolve()

    expect(navigate).not.toHaveBeenCalled()
    expect(operations.getAll()).toEqual([])
  })

  it.each(['reflect://today', 'reflect://note/y'])(
    'begins a navigation intent for address URL %s',
    (url) => {
      const { service, resolveNoteTarget, probes } = serveSession()
      resolveNoteTarget.mockResolvedValue(null)

      service.dispatch(url)

      expect(probes).toHaveLength(1)
    },
  )

  it.each([
    'reflect://append?text=captured',
    'reflect://task?text=captured',
    'reflect://edit-notes?content=invalid',
  ])('begins no navigation intent for non-navigation URL %s', (url) => {
    const { service, probes } = serveSession()

    service.dispatch(url)

    expect(probes).toEqual([])
  })

  it('logs a rejected handler instead of leaving an unhandled rejection', async () => {
    const { service, navigate, logger } = serveSession()
    const cause = new Error('router is gone')
    navigate.mockImplementation(() => {
      throw cause
    })

    service.dispatch('reflect://today')

    await vi.waitFor(() =>
      expect(logger.getErrors()).toEqual([{ message: 'deep link failed: reflect://today', cause }]),
    )
  })
})

describe('the initial-route slot', () => {
  it('holds the seeded route for the workspace mount', () => {
    const { service } = setup()
    expect(service.getInitialWindowRoute()).toBeNull()
    service.setInitialWindowRoute({ kind: 'note', path: 'notes/foo.md' })
    expect(service.getInitialWindowRoute()).toEqual({ kind: 'note', path: 'notes/foo.md' })
    // Idempotent reads: StrictMode double-invokes initializers.
    expect(service.getInitialWindowRoute()).toEqual({ kind: 'note', path: 'notes/foo.md' })
  })
})
