import { useRouter, type RouterNavigate } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import {
  createTestAppServices,
  createTestOperationsService,
  createTestWindowService,
  type TestOperationsService,
} from '@reflect/app/testing'
import {
  createTestCoreServices,
  createTestGraphSessionService,
  createTestLoggerService,
  type TestOpenGraph,
} from '@reflect/core/testing'
import type { MaybePromise } from '@reflect/utils'
import { createRef, useLayoutEffect, type ReactNode, type RefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useWikiLinkNavigation, type WikiLinkNavigation } from './use-wiki-link-navigation.ts'

const resolveWikiTarget = vi.fn()
const resolveExistingWikiTarget = vi.fn()
const resolveOrCreateNoteWithTitle = vi.fn()
// Receives the `reflect://` link of every note window a test opens.
const openNoteWindow = vi.fn<(deepLink: string) => MaybePromise<boolean>>()
const logger = createTestLoggerService()

const lastHandlerRef: RefObject<WikiLinkNavigation | null> = createRef()
const navigateRef: RefObject<RouterNavigate | null> = createRef()

function Host({ readOnly = false }: { readOnly?: boolean }): ReactNode {
  const lastHandler = useWikiLinkNavigation({ readOnly })
  const navigate = useRouter().navigate

  useLayoutEffect(() => {
    lastHandlerRef.current = lastHandler
    return () => {
      lastHandlerRef.current = null
    }
  }, [lastHandler])

  useLayoutEffect(() => {
    navigateRef.current = navigate
    return () => {
      navigateRef.current = null
    }
  }, [navigate])

  return null
}

function RouteProbe(): ReactNode {
  const { route, arrivalFocusEditor } = useRouter()
  return (
    <output data-testid="route" data-focus={String(arrivalFocusEditor)}>
      {JSON.stringify(route)}
    </output>
  )
}

/**
 * Render `ui` in an app whose link navigation runs on the scripted resolvers above.
 */
function renderWithLinkNavigation(ui: ReactNode, graph?: TestOpenGraph | null) {
  const base = createTestCoreServices({ database: createWasmTestDatabaseService() })
  const graphSession = createTestGraphSessionService()
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    progress: operations,
    graphSession,
  })
  const linkNavigation = createTestAppServices(
    createTestCoreServices({
      database: createWasmTestDatabaseService(),
      graphSession,
      wikiResolver: { ...base.wikiResolver, resolveWikiTarget },
      noteLinkResolver: {
        resolveWikiTarget: resolveExistingWikiTarget,
        resolveMarkdownHref: vi.fn(),
      },
      noteCreation: Object.assign(base.noteCreation, { resolveOrCreateNoteWithTitle }),
      progress: operations,
      logger,
    }),
    { window: createTestWindowService({ openNoteWindow }) },
  ).linkNavigation
  return renderInApp(ui, {
    app,
    appServices: { linkNavigation },
    graph,
  })
}

function renderHost(options: { graph?: TestOpenGraph | null; readOnly?: boolean } = {}) {
  return renderWithLinkNavigation(
    <>
      <Host readOnly={options.readOnly ?? false} />
      <RouteProbe />
    </>,
    options.graph,
  )
}

function currentRoute(view: Awaited<ReturnType<typeof renderHost>>): string {
  return view.getByTestId('route').element().textContent ?? ''
}

let operations: TestOperationsService

beforeEach(() => {
  operations = createTestOperationsService()
  openNoteWindow.mockReset().mockResolvedValue(true)
  resolveWikiTarget.mockReset()
  resolveExistingWikiTarget.mockReset()
  resolveOrCreateNoteWithTitle.mockReset()
  lastHandlerRef.current = null
  navigateRef.current = null
})

describe('useWikiLinkNavigation', () => {
  it('navigates to the resolved note', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/target.md',
    })
    const view = await renderHost()
    lastHandlerRef.current?.({ target: 'Target', openInNewWindow: false })
    await vi.waitFor(() => expect(currentRoute(view)).toContain('notes/target.md'))
    expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Target', 1)
    expect(resolveWikiTarget).not.toHaveBeenCalled()
  })

  it('arrives at a resolved note without a focus intent (no keyboard on navigation)', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/target.md',
    })
    const view = await renderHost()
    lastHandlerRef.current?.({ target: 'Target', openInNewWindow: false })
    await vi.waitFor(() => expect(currentRoute(view)).toContain('notes/target.md'))
    expect(view.getByTestId('route').element().getAttribute('data-focus')).toBe('false')
  })

  it('treats an unresolved ISO date as a daily target, without a focus intent', async () => {
    resolveExistingWikiTarget.mockResolvedValue({ kind: 'missing' })
    const view = await renderHost()
    lastHandlerRef.current?.({ target: '2026-06-09', openInNewWindow: false })
    await vi.waitFor(() => expect(currentRoute(view)).toContain('"daily"'))
    expect(currentRoute(view)).toContain('2026-06-09')
    expect(view.getByTestId('route').element().getAttribute('data-focus')).toBe('false')
    expect(resolveOrCreateNoteWithTitle).not.toHaveBeenCalled()
    expect(resolveExistingWikiTarget).toHaveBeenCalledWith('2026-06-09', 1)
    expect(resolveWikiTarget).not.toHaveBeenCalled()
  })

  it('preserves an existing regular note titled as an ISO date', async () => {
    resolveExistingWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/2026-06-09.md',
    })
    const view = await renderHost()

    lastHandlerRef.current?.({ target: '2026-06-09', openInNewWindow: false })

    await vi.waitFor(() => expect(currentRoute(view)).toContain('"note"'))
    expect(currentRoute(view)).toContain('notes/2026-06-09.md')
  })

  it('retains read-only index resolution for ISO dates when read-only', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'resolved', ref: 'notes/2026-06-09.md' })
    const view = await renderHost({ readOnly: true })

    lastHandlerRef.current?.({ target: '2026-06-09', openInNewWindow: false })

    await vi.waitFor(() => expect(currentRoute(view)).toContain('notes/2026-06-09.md'))
    expect(resolveWikiTarget).toHaveBeenCalledWith('2026-06-09')
    expect(resolveExistingWikiTarget).not.toHaveBeenCalled()
  })

  it('does not choose between ambiguous ISO-date targets', async () => {
    resolveExistingWikiTarget.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['daily/2026-06-09.md', 'daily/2026-06-09-2.md'],
    })
    const view = await renderHost()

    lastHandlerRef.current?.({ target: '2026-06-09', openInNewWindow: false })

    await vi.waitFor(() => {
      expect(operations.snapshot()).toContainEqual(expect.objectContaining({ status: 'failed' }))
    })
    expect(currentRoute(view)).toContain('"today"')
    expect(resolveOrCreateNoteWithTitle).not.toHaveBeenCalled()
  })

  it('does not turn an unavailable ISO-date target into a lazy daily route', async () => {
    resolveExistingWikiTarget.mockResolvedValue({
      kind: 'unavailable',
      paths: ['daily/2026-06-09.md'],
    })
    const view = await renderHost()

    lastHandlerRef.current?.({ target: '2026-06-09', openInNewWindow: false })

    await vi.waitFor(() => {
      expect(operations.snapshot()).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          message: expect.stringContaining('currently unavailable') as string,
        }),
      )
    })
    expect(currentRoute(view)).toContain('"today"')
  })

  it('routes a resolved daily alias through the daily view', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'resolved',
      path: 'daily/2026-06-09.md',
    })
    const view = await renderHost()

    lastHandlerRef.current?.({ target: 'Project log', openInNewWindow: false })

    await vi.waitFor(() => expect(currentRoute(view)).toContain('"daily"'))
    expect(currentRoute(view)).toContain('2026-06-09')
  })

  it('creates and opens an unresolved title, without a focus intent', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'created',
      path: 'notes/created.md',
    })
    const view = await renderHost({ graph: { generation: 7 } })
    lastHandlerRef.current?.({ target: 'Brand New', openInNewWindow: false })
    await vi.waitFor(() => expect(currentRoute(view)).toContain('notes/created.md'))
    expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Brand New', 7)
    expect(view.getByTestId('route').element().getAttribute('data-focus')).toBe('false')
  })

  it('does not create when read-only', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: 'Brand New' })
    const view = await renderHost({ readOnly: true })
    lastHandlerRef.current?.({ target: 'Brand New', openInNewWindow: false })
    await vi.waitFor(() => expect(resolveWikiTarget).toHaveBeenCalled())
    expect(resolveOrCreateNoteWithTitle).not.toHaveBeenCalled()
    expect(currentRoute(view)).toContain('"today"')
  })

  it('does not create with no graph open', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: 'Brand New' })
    const view = await renderHost({ graph: null })
    lastHandlerRef.current?.({ target: 'Brand New', openInNewWindow: false })
    await vi.waitFor(() => expect(resolveWikiTarget).toHaveBeenCalled())
    expect(resolveOrCreateNoteWithTitle).not.toHaveBeenCalled()
    expect(currentRoute(view)).toContain('"today"')
  })

  it('ignores an unresolved empty target', async () => {
    const view = await renderHost()
    lastHandlerRef.current?.({ target: '   ', openInNewWindow: false })
    await new Promise((tick) => setTimeout(tick, 0))
    expect(resolveWikiTarget).not.toHaveBeenCalled()
    expect(resolveOrCreateNoteWithTitle).not.toHaveBeenCalled()
    expect(currentRoute(view)).toContain('"today"')
  })

  it('an `openInNewWindow` request opens the resolved note in a new window instead of navigating', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/target.md',
    })
    const view = await renderHost()
    lastHandlerRef.current?.({ target: 'Target', openInNewWindow: true })
    await vi.waitFor(() => {
      expect(openNoteWindow).toHaveBeenCalledWith('reflect://note/notes%2Ftarget.md')
    })
    expect(currentRoute(view)).toContain('"today"') // this window stays put
  })

  it('an `openInNewWindow` request on an unresolved title still creates, then opens the new window', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'created',
      path: 'notes/created.md',
    })
    const view = await renderHost({ graph: { generation: 7 } })
    lastHandlerRef.current?.({ target: 'Brand New', openInNewWindow: true })
    await vi.waitFor(() => {
      expect(openNoteWindow).toHaveBeenCalledWith('reflect://note/notes%2Fcreated.md')
    })
    expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Brand New', 7)
    expect(currentRoute(view)).toContain('"today"')
  })

  it('does not navigate when indexed or on-disk title resolution is ambiguous', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['notes/business-ideas.md', 'notes/business-ideas-2.md'],
    })
    const view = await renderHost({ graph: { generation: 7 } })
    lastHandlerRef.current?.({ target: 'Business ideas', openInNewWindow: false })
    await vi.waitFor(() => expect(resolveOrCreateNoteWithTitle).toHaveBeenCalled())
    expect(currentRoute(view)).toContain('"today"')
    expect(resolveWikiTarget).not.toHaveBeenCalled()
    expect(operations.findByLabel('Opening link')).toMatchObject({
      status: 'failed',
      message:
        'Couldn’t safely choose one note matching “Business ideas”. Rename conflicting notes or wait for unavailable notes to become available, then try again.',
    })
  })

  it('does not navigate or create when a matching title is unavailable', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'unavailable',
      paths: ['notes/business-ideas.md'],
    })
    const view = await renderHost({ graph: { generation: 7 } })

    lastHandlerRef.current?.({ target: 'Business ideas', openInNewWindow: false })

    await vi.waitFor(() => {
      expect(operations.snapshot()).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          message: expect.stringContaining('currently unavailable') as string,
        }),
      )
    })
    expect(currentRoute(view)).toContain('"today"')
    expect(resolveWikiTarget).not.toHaveBeenCalled()
  })

  it('surfaces a resolution failure instead of silently doing nothing', async () => {
    const failure = new Error('index unavailable')
    resolveOrCreateNoteWithTitle.mockRejectedValue(failure)
    const view = await renderHost()

    lastHandlerRef.current?.({ target: 'Business ideas', openInNewWindow: false })

    await vi.waitFor(() => {
      expect(operations.findByLabel('Opening link')).toMatchObject({
        status: 'failed',
        message: 'index unavailable',
      })
    })
    expect(currentRoute(view)).toContain('"today"')
    expect(logger.getErrors()).toContainEqual({
      message: 'wiki-link resolution failed:',
      cause: failure,
    })
  })

  it('a declined new-window open falls back to in-window navigation', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/target.md',
    })
    openNoteWindow.mockResolvedValue(false)
    const view = await renderHost()
    lastHandlerRef.current?.({ target: 'Target', openInNewWindow: true })
    await vi.waitFor(() => expect(currentRoute(view)).toContain('notes/target.md'))
  })

  it('drops a resolution that lands after the host unmounts', async () => {
    const pending = Promise.withResolvers<{ kind: 'resolved'; path: string }>()
    resolveOrCreateNoteWithTitle.mockReturnValue(pending.promise)
    const view = await renderWithLinkNavigation(
      <>
        <Host key="host" />
        <RouteProbe key="probe" />
      </>,
    )
    lastHandlerRef.current?.({ target: 'Target', openInNewWindow: false })
    await vi.waitFor(() => expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Target', 1))
    // Unmount only the host; the router (and probe) live on, so a navigate
    // slipping through the guard would be visible as a route change.
    await view.rerender(
      <>
        <RouteProbe key="probe" />
      </>,
    )
    pending.resolve({ kind: 'resolved', path: 'notes/target.md' })
    await new Promise((tick) => setTimeout(tick, 0))
    expect(view.getByTestId('route').element().textContent).toContain('"today"')
  })

  it('drops an older resolution after a newer wiki-link click', async () => {
    const pendingOlder = Promise.withResolvers<{ kind: 'resolved'; path: string }>()
    resolveOrCreateNoteWithTitle.mockImplementation((target: string) => {
      if (target === 'Older') {
        return pendingOlder.promise
      }
      return Promise.resolve({ kind: 'resolved', path: 'notes/newer.md' })
    })
    const view = await renderHost()

    lastHandlerRef.current?.({ target: 'Older', openInNewWindow: false })
    await vi.waitFor(() => expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Older', 1))
    lastHandlerRef.current?.({ target: 'Newer', openInNewWindow: false })
    await vi.waitFor(() => expect(currentRoute(view)).toContain('notes/newer.md'))
    pendingOlder.resolve({ kind: 'resolved', path: 'notes/older.md' })
    await new Promise((tick) => setTimeout(tick, 0))

    expect(currentRoute(view)).toContain('notes/newer.md')
    expect(currentRoute(view)).not.toContain('notes/older.md')
  })

  it('drops a pending resolution after unrelated router navigation', async () => {
    const pendingResolution = Promise.withResolvers<{ kind: 'resolved'; path: string }>()
    resolveOrCreateNoteWithTitle.mockReturnValue(pendingResolution.promise)
    const view = await renderHost()

    lastHandlerRef.current?.({ target: 'Target', openInNewWindow: false })
    await vi.waitFor(() => expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Target', 1))
    navigateRef.current?.({ kind: 'settings' })
    await vi.waitFor(() => expect(currentRoute(view)).toContain('"settings"'))

    pendingResolution.resolve({ kind: 'resolved', path: 'notes/target.md' })
    await new Promise((tick) => setTimeout(tick, 0))

    expect(currentRoute(view)).toContain('"settings"')
    expect(currentRoute(view)).not.toContain('notes/target.md')
  })

  it('drops a pending note creation after unrelated router navigation', async () => {
    const pendingCreation = Promise.withResolvers<{ kind: 'created'; path: string }>()
    resolveOrCreateNoteWithTitle.mockReturnValue(pendingCreation.promise)
    const view = await renderHost({ graph: { generation: 7 } })

    lastHandlerRef.current?.({ target: 'Brand New', openInNewWindow: false })
    await vi.waitFor(() => {
      expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Brand New', 7)
    })
    navigateRef.current?.({ kind: 'settings' })
    await vi.waitFor(() => expect(currentRoute(view)).toContain('"settings"'))

    pendingCreation.resolve({ kind: 'created', path: 'notes/created.md' })
    await new Promise((tick) => setTimeout(tick, 0))

    expect(currentRoute(view)).toContain('"settings"')
    expect(currentRoute(view)).not.toContain('notes/created.md')
  })
})
