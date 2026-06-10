import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { useWikiLinkNavigation } from './use-wiki-link-navigation'

const resolveWikiTarget = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  resolveWikiTarget,
}))

const createNoteWithTitle = vi.hoisted(() => vi.fn())
vi.mock('@/lib/create-note', () => ({ createNoteWithTitle }))

let lastHandler: ((target: string) => void) | null = null

function Host({ generation }: { generation: number | null }): ReactNode {
  lastHandler = useWikiLinkNavigation(generation)
  return null
}

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
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
  createNoteWithTitle.mockReset()
  lastHandler = null
})

describe('useWikiLinkNavigation', () => {
  it('navigates to the resolved note', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'resolved', ref: 'notes/target.md' })
    const view = renderHost()
    lastHandler?.('Target')
    await waitFor(() => expect(currentRoute(view)).toContain('notes/target.md'))
    expect(createNoteWithTitle).not.toHaveBeenCalled()
    view.unmount()
  })

  it('treats an unresolved ISO date as a daily target', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: '2026-06-09' })
    const view = renderHost()
    lastHandler?.('2026-06-09')
    await waitFor(() => expect(currentRoute(view)).toContain('"daily"'))
    expect(currentRoute(view)).toContain('2026-06-09')
    expect(createNoteWithTitle).not.toHaveBeenCalled()
    view.unmount()
  })

  it('creates and opens an unresolved title', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: 'Brand New' })
    createNoteWithTitle.mockResolvedValue('notes/created.md')
    const view = renderHost(7)
    lastHandler?.('Brand New')
    await waitFor(() => expect(currentRoute(view)).toContain('notes/created.md'))
    expect(createNoteWithTitle).toHaveBeenCalledWith('Brand New', 7)
    view.unmount()
  })

  it('does not create when no generation is available', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: 'Brand New' })
    const view = renderHost(null)
    lastHandler?.('Brand New')
    await waitFor(() => expect(resolveWikiTarget).toHaveBeenCalled())
    expect(createNoteWithTitle).not.toHaveBeenCalled()
    expect(currentRoute(view)).toContain('"today"')
    view.unmount()
  })

  it('ignores an unresolved empty target', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: '   ' })
    const view = renderHost()
    lastHandler?.('   ')
    await waitFor(() => expect(resolveWikiTarget).toHaveBeenCalled())
    expect(createNoteWithTitle).not.toHaveBeenCalled()
    expect(currentRoute(view)).toContain('"today"')
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
})
