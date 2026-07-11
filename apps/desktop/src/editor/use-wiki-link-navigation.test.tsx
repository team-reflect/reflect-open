import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { useWikiLinkNavigation } from './use-wiki-link-navigation'

const resolveWikiTarget = vi.hoisted(() => vi.fn())
const resolveOrCreateNoteWithTitle = vi.hoisted(() => vi.fn())
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() => vi.fn(() => ({ fail: operationFail })))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  resolveWikiTarget,
  resolveOrCreateNoteWithTitle,
}))
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openRouteInNewWindow,
}))
vi.mock('@/lib/operations', () => ({ startOperation }))

let lastHandler: ((target: string, event?: MouseEvent | KeyboardEvent) => void) | null = null
let navigate: ReturnType<typeof useRouter>['navigate'] | null = null

function Host({ generation }: { generation: number | null }): ReactNode {
  lastHandler = useWikiLinkNavigation(generation)
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
  resolveOrCreateNoteWithTitle.mockReset()
  openRouteInNewWindow.mockReset()
  openRouteInNewWindow.mockResolvedValue(true)
  operationFail.mockReset()
  startOperation.mockClear()
  lastHandler = null
  navigate = null
})

describe('useWikiLinkNavigation', () => {
  it('navigates to the resolved note', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'resolved', ref: 'notes/target.md' })
    const view = renderHost()
    lastHandler?.('Target')
    await waitFor(() => expect(currentRoute(view)).toContain('notes/target.md'))
    expect(resolveOrCreateNoteWithTitle).not.toHaveBeenCalled()
    view.unmount()
  })

  it('arrives at a resolved note without a focus intent (no keyboard on navigation)', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'resolved', ref: 'notes/target.md' })
    const view = renderHost()
    lastHandler?.('Target')
    await waitFor(() => expect(currentRoute(view)).toContain('notes/target.md'))
    expect(view.getByTestId('route').getAttribute('data-focus')).toBe('false')
    view.unmount()
  })

  it('treats an unresolved ISO date as a daily target, without a focus intent', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: '2026-06-09' })
    const view = renderHost()
    lastHandler?.('2026-06-09')
    await waitFor(() => expect(currentRoute(view)).toContain('"daily"'))
    expect(currentRoute(view)).toContain('2026-06-09')
    expect(view.getByTestId('route').getAttribute('data-focus')).toBe('false')
    expect(resolveOrCreateNoteWithTitle).not.toHaveBeenCalled()
    view.unmount()
  })

  it('creates and opens an unresolved title, without a focus intent', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: 'Brand New' })
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'created',
      path: 'notes/created.md',
    })
    const view = renderHost(7)
    lastHandler?.('Brand New')
    await waitFor(() => expect(currentRoute(view)).toContain('notes/created.md'))
    expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Brand New', 7)
    expect(view.getByTestId('route').getAttribute('data-focus')).toBe('false')
    view.unmount()
  })

  it('does not create when no generation is available', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: 'Brand New' })
    const view = renderHost(null)
    lastHandler?.('Brand New')
    await waitFor(() => expect(resolveWikiTarget).toHaveBeenCalled())
    expect(resolveOrCreateNoteWithTitle).not.toHaveBeenCalled()
    expect(currentRoute(view)).toContain('"today"')
    view.unmount()
  })

  it('ignores an unresolved empty target', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: '   ' })
    const view = renderHost()
    lastHandler?.('   ')
    await waitFor(() => expect(resolveWikiTarget).toHaveBeenCalled())
    expect(resolveOrCreateNoteWithTitle).not.toHaveBeenCalled()
    expect(currentRoute(view)).toContain('"today"')
    view.unmount()
  })

  it('⌘-click opens the resolved note in a new window instead of navigating', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'resolved', ref: 'notes/target.md' })
    const view = renderHost()
    lastHandler?.('Target', new MouseEvent('click', { metaKey: true }))
    await waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({ kind: 'note', path: 'notes/target.md' }),
    )
    expect(currentRoute(view)).toContain('"today"') // this window stays put
    view.unmount()
  })

  it('⌘-click on an unresolved title still creates, then opens the new window', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: 'Brand New' })
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'created',
      path: 'notes/created.md',
    })
    const view = renderHost(7)
    lastHandler?.('Brand New', new MouseEvent('click', { metaKey: true }))
    await waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({ kind: 'note', path: 'notes/created.md' }),
    )
    expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Brand New', 7)
    expect(currentRoute(view)).toContain('"today"')
    view.unmount()
  })

  it('does not navigate when the on-disk fallback is ambiguous', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: 'Business ideas' })
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['notes/business-ideas.md', 'notes/business-ideas-2.md'],
    })
    const view = renderHost(7)
    lastHandler?.('Business ideas')
    await waitFor(() => expect(resolveOrCreateNoteWithTitle).toHaveBeenCalled())
    expect(currentRoute(view)).toContain('"today"')
    expect(startOperation).toHaveBeenCalledWith('Opening link')
    expect(operationFail).toHaveBeenCalledWith(
      'Couldn’t safely choose one note matching “Business ideas”. Choose the intended note from autocomplete.',
    )
    view.unmount()
  })

  it('a declined new-window open falls back to in-window navigation', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'resolved', ref: 'notes/target.md' })
    openRouteInNewWindow.mockResolvedValue(false)
    const view = renderHost()
    lastHandler?.('Target', new MouseEvent('click', { metaKey: true }))
    await waitFor(() => expect(currentRoute(view)).toContain('notes/target.md'))
    view.unmount()
  })

  it('a Mod-Enter keyboard follow stays in-window despite the held modifier', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'resolved', ref: 'notes/target.md' })
    const view = renderHost()
    lastHandler?.('Target', new KeyboardEvent('keydown', { metaKey: true }))
    await waitFor(() => expect(currentRoute(view)).toContain('notes/target.md'))
    expect(openRouteInNewWindow).not.toHaveBeenCalled()
    view.unmount()
  })

  it('drops a resolution that lands after the host unmounts', async () => {
    let resolve: (value: { kind: 'resolved'; ref: string }) => void = () => {}
    resolveWikiTarget.mockReturnValue(
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
    await waitFor(() => expect(resolveWikiTarget).toHaveBeenCalledWith('Target'))
    // Unmount only the host; the router (and probe) live on, so a navigate
    // slipping through the guard would be visible as a route change.
    view.rerender(
      <RouterProvider>
        <RouteProbe key="probe" />
      </RouterProvider>,
    )
    resolve({ kind: 'resolved', ref: 'notes/target.md' })
    await new Promise((tick) => setTimeout(tick, 0))
    expect(view.getByTestId('route').textContent).toContain('"today"')
    view.unmount()
  })

  it('drops an older resolution after a newer wiki-link click', async () => {
    let finishOlder: (value: { kind: 'resolved'; ref: string }) => void = () => {}
    resolveWikiTarget.mockImplementation((target: string) => {
      if (target === 'Older') {
        return new Promise((resolve) => {
          finishOlder = resolve
        })
      }
      return Promise.resolve({ kind: 'resolved', ref: 'notes/newer.md' })
    })
    const view = renderHost()

    lastHandler?.('Older')
    await waitFor(() => expect(resolveWikiTarget).toHaveBeenCalledWith('Older'))
    lastHandler?.('Newer')
    await waitFor(() => expect(currentRoute(view)).toContain('notes/newer.md'))
    finishOlder({ kind: 'resolved', ref: 'notes/older.md' })
    await new Promise((tick) => setTimeout(tick, 0))

    expect(currentRoute(view)).toContain('notes/newer.md')
    expect(currentRoute(view)).not.toContain('notes/older.md')
    view.unmount()
  })

  it('drops a pending resolution after unrelated router navigation', async () => {
    let finishResolution: (value: { kind: 'resolved'; ref: string }) => void = () => {}
    resolveWikiTarget.mockReturnValue(
      new Promise((resolve) => {
        finishResolution = resolve
      }),
    )
    const view = renderHost()

    lastHandler?.('Target')
    await waitFor(() => expect(resolveWikiTarget).toHaveBeenCalledWith('Target'))
    navigate?.({ kind: 'settings' })
    await waitFor(() => expect(currentRoute(view)).toContain('"settings"'))

    finishResolution({ kind: 'resolved', ref: 'notes/target.md' })
    await new Promise((tick) => setTimeout(tick, 0))

    expect(currentRoute(view)).toContain('"settings"')
    expect(currentRoute(view)).not.toContain('notes/target.md')
    view.unmount()
  })

  it('drops a pending note creation after unrelated router navigation', async () => {
    let finishCreation: (outcome: { kind: 'created'; path: string }) => void = () => {}
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: 'Brand New' })
    resolveOrCreateNoteWithTitle.mockReturnValue(
      new Promise((resolve) => {
        finishCreation = resolve
      }),
    )
    const view = renderHost(7)

    lastHandler?.('Brand New')
    await waitFor(() =>
      expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Brand New', 7),
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
