import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
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

function currentRoute(view: Awaited<ReturnType<typeof renderHost>>): string {
  return view.getByTestId('route').element().textContent ?? ''
}

beforeEach(() => {
  resolveWikiTarget.mockReset()
  createNoteWithTitle.mockReset()
  lastHandler = null
})

describe('useWikiLinkNavigation', () => {
  it('navigates to the resolved note', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'resolved', ref: 'notes/target.md' })
    const view = await renderHost()
    lastHandler?.('Target')
    await expect.element(view.getByTestId('route')).toHaveTextContent('notes/target.md')
    expect(createNoteWithTitle).not.toHaveBeenCalled()
  })

  it('treats an unresolved ISO date as a daily target', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: '2026-06-09' })
    const view = await renderHost()
    lastHandler?.('2026-06-09')
    await expect.element(view.getByTestId('route')).toHaveTextContent('"daily"')
    expect(currentRoute(view)).toContain('2026-06-09')
    expect(createNoteWithTitle).not.toHaveBeenCalled()
  })

  it('creates and opens an unresolved title', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: 'Brand New' })
    createNoteWithTitle.mockResolvedValue('notes/created.md')
    const view = await renderHost(7)
    lastHandler?.('Brand New')
    await expect.element(view.getByTestId('route')).toHaveTextContent('notes/created.md')
    expect(createNoteWithTitle).toHaveBeenCalledWith('Brand New', 7)
  })

  it('does not create when no generation is available', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: 'Brand New' })
    const view = await renderHost(null)
    lastHandler?.('Brand New')
    await vi.waitFor(() => expect(resolveWikiTarget).toHaveBeenCalled())
    expect(createNoteWithTitle).not.toHaveBeenCalled()
    expect(currentRoute(view)).toContain('"today"')
  })

  it('ignores an unresolved empty target', async () => {
    resolveWikiTarget.mockResolvedValue({ kind: 'unresolved', text: '   ' })
    const view = await renderHost()
    lastHandler?.('   ')
    await vi.waitFor(() => expect(resolveWikiTarget).toHaveBeenCalled())
    expect(createNoteWithTitle).not.toHaveBeenCalled()
    expect(currentRoute(view)).toContain('"today"')
  })

  it('drops a resolution that lands after the host unmounts', async () => {
    let resolve: (value: { kind: 'resolved'; ref: string }) => void = () => {}
    resolveWikiTarget.mockReturnValue(
      new Promise((promiseResolve) => {
        resolve = promiseResolve
      }),
    )
    const view = await render(
      <RouterProvider>
        <Host key="host" generation={1} />
        <RouteProbe key="probe" />
      </RouterProvider>,
    )
    lastHandler?.('Target')
    // Unmount only the host; the router (and probe) live on, so a navigate
    // slipping through the guard would be visible as a route change.
    await view.rerender(
      <RouterProvider>
        <RouteProbe key="probe" />
      </RouterProvider>,
    )
    resolve({ kind: 'resolved', ref: 'notes/target.md' })
    await new Promise((tick) => setTimeout(tick, 0))
    expect(currentRoute(view)).toContain('"today"')
  })
})
