import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { useWikiLinkNavigation } from './use-wiki-link-navigation'

const resolveWikiTarget = vi.hoisted(() => vi.fn())
const resolveExistingWikiTarget = vi.hoisted(() => vi.fn())
const resolveOrCreateWikiTarget = vi.hoisted(() => vi.fn())
const chooseAmbiguousNote = vi.hoisted(() => vi.fn())
const requestNoteHeadingReveal = vi.hoisted(() => vi.fn())
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() => vi.fn(() => ({ fail: operationFail })))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  resolveWikiTarget,
  resolveExistingWikiTarget,
  resolveOrCreateWikiTarget,
}))
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openRouteInNewWindow,
}))
vi.mock('@/lib/operations', () => ({ startOperation }))
vi.mock('@/editor/ambiguous-note-chooser-store', () => ({ chooseAmbiguousNote }))
vi.mock('@/editor/editor-handle-registry', () => ({ requestNoteHeadingReveal }))

let lastHandler: ((target: string, event?: MouseEvent | KeyboardEvent) => void) | null = null
let navigate: ReturnType<typeof useRouter>['navigate'] | null = null

function Host({ generation }: { generation: number | null }): ReactNode {
  lastHandler = useWikiLinkNavigation(generation, 'Projects/source.md')
  navigate = useRouter().navigate
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

function renderHost(generation: number | null = 1) {
  return render(
    <RouterProvider>
      <Host generation={generation} />
      <RouteProbe />
    </RouterProvider>,
  )
}

function currentRoute(view: ReturnType<typeof renderHost>): string {
  return view.getByTestId('route').textContent ?? ''
}

beforeEach(() => {
  resolveWikiTarget.mockReset()
  resolveExistingWikiTarget.mockReset()
  resolveOrCreateWikiTarget.mockReset()
  chooseAmbiguousNote.mockReset().mockResolvedValue(null)
  requestNoteHeadingReveal.mockReset()
  openRouteInNewWindow.mockReset()
  openRouteInNewWindow.mockResolvedValue(true)
  operationFail.mockReset()
  startOperation.mockClear()
  lastHandler = null
  navigate = null
})

afterEach(cleanup)

describe('useWikiLinkNavigation', () => {
  it('navigates to the resolved note', async () => {
    resolveOrCreateWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/target.md',
    })
    const view = renderHost()
    lastHandler?.('Target')
    await waitFor(() => expect(currentRoute(view)).toContain('notes/target.md'))
    expect(resolveOrCreateWikiTarget).toHaveBeenCalledWith('Target', 'Projects/source.md', 1)
    expect(resolveWikiTarget).not.toHaveBeenCalled()
    view.unmount()
  })

  it('resolves path-qualified targets from the source note and reveals their heading', async () => {
    resolveOrCreateWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'Projects/Plan.md',
    })
    const view = renderHost()

    lastHandler?.('Projects/Plan#Roadmap')

    await waitFor(() => expect(currentRoute(view)).toContain('Projects/Plan.md'))
    expect(resolveOrCreateWikiTarget).toHaveBeenCalledWith(
      'Projects/Plan#Roadmap',
      'Projects/source.md',
      1,
    )
    expect(requestNoteHeadingReveal).toHaveBeenCalledWith('Projects/Plan.md', 'Roadmap', 1)
    view.unmount()
  })

  it('rejects an unsafe path target without resolving or creating it', async () => {
    const view = renderHost()

    lastHandler?.('../Secret')

    await waitFor(() =>
      expect(operationFail).toHaveBeenCalledWith(
        'Couldn’t open “../Secret” because it isn’t a safe Markdown note link.',
      ),
    )
    expect(resolveOrCreateWikiTarget).not.toHaveBeenCalled()
    expect(currentRoute(view)).toContain('"today"')
    view.unmount()
  })

  it('arrives at a resolved note without a focus intent (no keyboard on navigation)', async () => {
    resolveOrCreateWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/target.md',
    })
    const view = renderHost()
    lastHandler?.('Target')
    await waitFor(() => expect(currentRoute(view)).toContain('notes/target.md'))
    expect(view.getByTestId('route').getAttribute('data-focus')).toBe('false')
    view.unmount()
  })

  it('treats an unresolved ISO date as a daily target, without a focus intent', async () => {
    resolveExistingWikiTarget.mockResolvedValue({ kind: 'missing' })
    const view = renderHost()
    lastHandler?.('2026-06-09')
    await waitFor(() => expect(currentRoute(view)).toContain('"daily"'))
    expect(currentRoute(view)).toContain('2026-06-09')
    expect(view.getByTestId('route').getAttribute('data-focus')).toBe('false')
    expect(resolveOrCreateWikiTarget).not.toHaveBeenCalled()
    expect(resolveExistingWikiTarget).toHaveBeenCalledWith('2026-06-09', 1, 'Projects/source.md')
    expect(resolveWikiTarget).not.toHaveBeenCalled()
    view.unmount()
  })

  it('preserves an existing regular note titled as an ISO date', async () => {
    resolveExistingWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/2026-06-09.md',
    })
    const view = renderHost()

    lastHandler?.('2026-06-09')

    await waitFor(() => expect(currentRoute(view)).toContain('"note"'))
    expect(currentRoute(view)).toContain('notes/2026-06-09.md')
    view.unmount()
  })

  it('retains read-only index resolution for ISO dates without a graph generation', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'resolved', ref: 'notes/2026-06-09.md' })
    const view = renderHost(null)

    lastHandler?.('2026-06-09')

    await waitFor(() => expect(currentRoute(view)).toContain('notes/2026-06-09.md'))
    expect(resolveWikiTarget).toHaveBeenCalledWith('2026-06-09')
    expect(resolveExistingWikiTarget).not.toHaveBeenCalled()
    view.unmount()
  })

  it('offers a chooser for ambiguous ISO-date targets', async () => {
    resolveExistingWikiTarget.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['daily/2026-06-09.md', 'daily/2026-06-09-2.md'],
    })
    const view = renderHost()

    lastHandler?.('2026-06-09')

    await waitFor(() =>
      expect(chooseAmbiguousNote).toHaveBeenCalledWith('2026-06-09', [
        'daily/2026-06-09.md',
        'daily/2026-06-09-2.md',
      ]),
    )
    expect(currentRoute(view)).toContain('"today"')
    expect(resolveOrCreateWikiTarget).not.toHaveBeenCalled()
    view.unmount()
  })

  it('does not turn an unavailable ISO-date target into a lazy daily route', async () => {
    resolveExistingWikiTarget.mockResolvedValue({
      kind: 'unavailable',
      paths: ['daily/2026-06-09.md'],
    })
    const view = renderHost()

    lastHandler?.('2026-06-09')

    await waitFor(() =>
      expect(operationFail).toHaveBeenCalledWith(
        expect.stringContaining('currently unavailable'),
      ),
    )
    expect(currentRoute(view)).toContain('"today"')
    view.unmount()
  })

  it('routes a resolved daily alias through the daily view', async () => {
    resolveOrCreateWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'daily/2026-06-09.md',
    })
    const view = renderHost()

    lastHandler?.('Project log')

    await waitFor(() => expect(currentRoute(view)).toContain('"daily"'))
    expect(currentRoute(view)).toContain('2026-06-09')
    view.unmount()
  })

  it('creates and opens an unresolved title, without a focus intent', async () => {
    resolveOrCreateWikiTarget.mockResolvedValue({
      kind: 'created',
      path: 'notes/created.md',
    })
    const view = renderHost(7)
    lastHandler?.('Brand New')
    await waitFor(() => expect(currentRoute(view)).toContain('notes/created.md'))
    expect(resolveOrCreateWikiTarget).toHaveBeenCalledWith('Brand New', 'Projects/source.md', 7)
    expect(view.getByTestId('route').getAttribute('data-focus')).toBe('false')
    view.unmount()
  })

  it('does not create when no generation is available', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: 'Brand New' })
    const view = renderHost(null)
    lastHandler?.('Brand New')
    await waitFor(() => expect(resolveWikiTarget).toHaveBeenCalled())
    expect(resolveOrCreateWikiTarget).not.toHaveBeenCalled()
    expect(currentRoute(view)).toContain('"today"')
    view.unmount()
  })

  it('ignores an unresolved empty target', async () => {
    const view = renderHost()
    lastHandler?.('   ')
    await new Promise((tick) => setTimeout(tick, 0))
    expect(resolveWikiTarget).not.toHaveBeenCalled()
    expect(resolveOrCreateWikiTarget).not.toHaveBeenCalled()
    expect(currentRoute(view)).toContain('"today"')
    view.unmount()
  })

  it('⌘-click opens the resolved note in a new window instead of navigating', async () => {
    resolveOrCreateWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/target.md',
    })
    const view = renderHost()
    lastHandler?.('Target', new MouseEvent('click', { metaKey: true }))
    await waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({ kind: 'note', path: 'notes/target.md' }),
    )
    expect(currentRoute(view)).toContain('"today"') // this window stays put
    view.unmount()
  })

  it('⌘-click on an unresolved title still creates, then opens the new window', async () => {
    resolveOrCreateWikiTarget.mockResolvedValue({
      kind: 'created',
      path: 'notes/created.md',
    })
    const view = renderHost(7)
    lastHandler?.('Brand New', new MouseEvent('click', { metaKey: true }))
    await waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({ kind: 'note', path: 'notes/created.md' }),
    )
    expect(resolveOrCreateWikiTarget).toHaveBeenCalledWith('Brand New', 'Projects/source.md', 7)
    expect(currentRoute(view)).toContain('"today"')
    view.unmount()
  })

  it('opens the duplicate selected in the ambiguity chooser', async () => {
    resolveOrCreateWikiTarget.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['notes/business-ideas.md', 'notes/business-ideas-2.md'],
    })
    chooseAmbiguousNote.mockResolvedValue('notes/business-ideas-2.md')
    const view = renderHost(7)
    lastHandler?.('Business ideas')
    await waitFor(() => expect(currentRoute(view)).toContain('business-ideas-2.md'))
    expect(resolveWikiTarget).not.toHaveBeenCalled()
    expect(chooseAmbiguousNote).toHaveBeenCalledWith(
      'Business ideas',
      ['notes/business-ideas.md', 'notes/business-ideas-2.md'],
    )
    view.unmount()
  })

  it('does not navigate or create when a matching title is unavailable', async () => {
    resolveOrCreateWikiTarget.mockResolvedValue({
      kind: 'unavailable',
      paths: ['notes/business-ideas.md'],
    })
    const view = renderHost(7)

    lastHandler?.('Business ideas')

    await waitFor(() =>
      expect(operationFail).toHaveBeenCalledWith(
        expect.stringContaining('currently unavailable'),
      ),
    )
    expect(currentRoute(view)).toContain('"today"')
    expect(resolveWikiTarget).not.toHaveBeenCalled()
    view.unmount()
  })

  it('surfaces a resolution failure instead of silently doing nothing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    resolveOrCreateWikiTarget.mockRejectedValue(new Error('index unavailable'))
    const view = renderHost()

    lastHandler?.('Business ideas')

    await waitFor(() => expect(operationFail).toHaveBeenCalledWith('index unavailable'))
    expect(startOperation).toHaveBeenCalledWith('Opening link')
    expect(currentRoute(view)).toContain('"today"')
    consoleError.mockRestore()
    view.unmount()
  })

  it('a declined new-window open falls back to in-window navigation', async () => {
    resolveOrCreateWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/target.md',
    })
    openRouteInNewWindow.mockResolvedValue(false)
    const view = renderHost()
    lastHandler?.('Target', new MouseEvent('click', { metaKey: true }))
    await waitFor(() => expect(currentRoute(view)).toContain('notes/target.md'))
    view.unmount()
  })

  it('a Mod-Enter keyboard follow stays in-window despite the held modifier', async () => {
    resolveOrCreateWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/target.md',
    })
    const view = renderHost()
    lastHandler?.('Target', new KeyboardEvent('keydown', { metaKey: true }))
    await waitFor(() => expect(currentRoute(view)).toContain('notes/target.md'))
    expect(openRouteInNewWindow).not.toHaveBeenCalled()
    view.unmount()
  })

  it('drops a resolution that lands after the host unmounts', async () => {
    let resolve: (value: { kind: 'resolved'; path: string }) => void = () => {}
    resolveOrCreateWikiTarget.mockReturnValue(
      new Promise((promiseResolve) => {
        resolve = promiseResolve
      }),
    )
    const view = render(
      <RouterProvider>
        <Host key="host" generation={1} />
        <RouteProbe key="probe" />
      </RouterProvider>,
    )
    lastHandler?.('Target')
    await waitFor(() =>
      expect(resolveOrCreateWikiTarget).toHaveBeenCalledWith('Target', 'Projects/source.md', 1),
    )
    // Unmount only the host; the router (and probe) live on, so a navigate
    // slipping through the guard would be visible as a route change.
    view.rerender(
      <RouterProvider>
        <RouteProbe key="probe" />
      </RouterProvider>,
    )
    resolve({ kind: 'resolved', path: 'notes/target.md' })
    await new Promise((tick) => setTimeout(tick, 0))
    expect(view.getByTestId('route').textContent).toContain('"today"')
    view.unmount()
  })

  it('drops an older resolution after a newer wiki-link click', async () => {
    let finishOlder: (value: { kind: 'resolved'; path: string }) => void = () => {}
    resolveOrCreateWikiTarget.mockImplementation((target: string) => {
      if (target === 'Older') {
        return new Promise((resolve) => {
          finishOlder = resolve
        })
      }
      return Promise.resolve({ kind: 'resolved', path: 'notes/newer.md' })
    })
    const view = renderHost()

    lastHandler?.('Older')
    await waitFor(() =>
      expect(resolveOrCreateWikiTarget).toHaveBeenCalledWith('Older', 'Projects/source.md', 1),
    )
    lastHandler?.('Newer')
    await waitFor(() => expect(currentRoute(view)).toContain('notes/newer.md'))
    finishOlder({ kind: 'resolved', path: 'notes/older.md' })
    await new Promise((tick) => setTimeout(tick, 0))

    expect(currentRoute(view)).toContain('notes/newer.md')
    expect(currentRoute(view)).not.toContain('notes/older.md')
    view.unmount()
  })

  it('drops a pending resolution after unrelated router navigation', async () => {
    let finishResolution: (value: { kind: 'resolved'; path: string }) => void = () => {}
    resolveOrCreateWikiTarget.mockReturnValue(
      new Promise((resolve) => {
        finishResolution = resolve
      }),
    )
    const view = renderHost()

    lastHandler?.('Target')
    await waitFor(() =>
      expect(resolveOrCreateWikiTarget).toHaveBeenCalledWith('Target', 'Projects/source.md', 1),
    )
    navigate?.({ kind: 'settings' })
    await waitFor(() => expect(currentRoute(view)).toContain('"settings"'))

    finishResolution({ kind: 'resolved', path: 'notes/target.md' })
    await new Promise((tick) => setTimeout(tick, 0))

    expect(currentRoute(view)).toContain('"settings"')
    expect(currentRoute(view)).not.toContain('notes/target.md')
    view.unmount()
  })

  it('drops a pending note creation after unrelated router navigation', async () => {
    let finishCreation: (outcome: { kind: 'created'; path: string }) => void = () => {}
    resolveOrCreateWikiTarget.mockReturnValue(
      new Promise((resolve) => {
        finishCreation = resolve
      }),
    )
    const view = renderHost(7)

    lastHandler?.('Brand New')
    await waitFor(() =>
      expect(resolveOrCreateWikiTarget).toHaveBeenCalledWith('Brand New', 'Projects/source.md', 7),
    )
    navigate?.({ kind: 'settings' })
    await waitFor(() => expect(currentRoute(view)).toContain('"settings"'))

    finishCreation({ kind: 'created', path: 'notes/created.md' })
    await new Promise((tick) => setTimeout(tick, 0))

    expect(currentRoute(view)).toContain('"settings"')
    expect(currentRoute(view)).not.toContain('notes/created.md')
    view.unmount()
  })
})
