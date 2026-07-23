import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { ReactElement } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { useNoteLinkNavigation } from './use-note-link-navigation'

const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())

vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openRouteInNewWindow,
}))

function Links({ scopeKey }: { readonly scopeKey: string | undefined }): ReactElement {
  const openNoteLink = useNoteLinkNavigation(scopeKey)
  return (
    <>
      <button
        type="button"
        onClick={(event) => openNoteLink({ kind: 'note', path: 'notes/alpha.md' }, event)}
      >
        Alpha
      </button>
      <button
        type="button"
        onClick={(event) => openNoteLink({ kind: 'note', path: 'notes/bravo.md' }, event)}
      >
        Bravo
      </button>
    </>
  )
}

function RouteProbe(): ReactElement {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function ReopenCurrentRoute(): ReactElement {
  const { navigate } = useRouter()
  return (
    <button type="button" onClick={() => navigate({ kind: 'allNotes', tag: null })}>
      Reopen current route
    </button>
  )
}

interface HarnessProps {
  readonly scopeKey?: string
  readonly visible?: boolean
}

function Harness({ scopeKey, visible = true }: HarnessProps): ReactElement {
  return (
    <RouterProvider initialRoute={{ kind: 'allNotes', tag: null }}>
      {visible ? <Links scopeKey={scopeKey} /> : null}
      <ReopenCurrentRoute />
      <RouteProbe />
    </RouterProvider>
  )
}

function route(view: Awaited<ReturnType<typeof render>>): unknown {
  return JSON.parse(view.getByTestId('route').element().textContent ?? 'null')
}

/** Lets a settled fallback promise run its continuation (and any React flush it would cause). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

beforeEach(() => {
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
})

describe('useNoteLinkNavigation', () => {
  it('navigates a plain click in the current window', async () => {
    const view = await render(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click()

    await expect.poll(() => route(view)).toEqual({ kind: 'note', path: 'notes/alpha.md' })
    expect(openRouteInNewWindow).not.toHaveBeenCalled()
  })

  it('opens a modifier-click in a secondary window without navigating', async () => {
    const view = await render(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['Meta'] })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/alpha.md',
      }),
    )
    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })

  it('falls back to current-window navigation when a secondary window is declined', async () => {
    openRouteInNewWindow.mockResolvedValue(false)
    const view = await render(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['Meta'] })

    await expect.poll(() => route(view)).toEqual({ kind: 'note', path: 'notes/alpha.md' })
  })

  it('falls back to current-window navigation when a secondary window open rejects', async () => {
    openRouteInNewWindow.mockRejectedValue(new Error('window creation failed'))
    const view = await render(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['Meta'] })

    await expect.poll(() => route(view)).toEqual({ kind: 'note', path: 'notes/alpha.md' })
  })

  it('does not let an older failed open override a newer note-link intent', async () => {
    let finishOpen: (opened: boolean) => void = () => {}
    openRouteInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    const view = await render(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['Meta'] })
    await vi.waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    await view.getByRole('button', { name: 'Bravo' }).click()
    await expect.poll(() => route(view)).toEqual({ kind: 'note', path: 'notes/bravo.md' })

    finishOpen(false)
    await settle()

    expect(route(view)).toEqual({ kind: 'note', path: 'notes/bravo.md' })
  })

  it('does not let an older rejected open override a newer note-link intent', async () => {
    let rejectOpen: (cause: Error) => void = () => {}
    openRouteInNewWindow
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOpen = reject
          }),
      )
      .mockResolvedValueOnce(true)
    const view = await render(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['Meta'] })
    await vi.waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    await view.getByRole('button', { name: 'Bravo' }).click({ modifiers: ['Meta'] })
    await vi.waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(2))

    rejectOpen(new Error('window creation failed'))
    await settle()

    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })

  it('does not fall back after another control re-navigates to the same route', async () => {
    let finishOpen: (opened: boolean) => void = () => {}
    openRouteInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    const view = await render(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['Meta'] })
    await vi.waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    await view.getByRole('button', { name: 'Reopen current route' }).click()
    finishOpen(false)
    await settle()

    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })

  it('does not fall back after the host surface changes scope', async () => {
    let finishOpen: (opened: boolean) => void = () => {}
    openRouteInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    const view = await render(<Harness scopeKey="2026-07-10" />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['Meta'] })
    await vi.waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    await view.rerender(<Harness scopeKey="2026-07-11" />)
    finishOpen(false)
    await settle()

    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })

  it('does not navigate after the link host unmounts', async () => {
    let finishOpen: (opened: boolean) => void = () => {}
    openRouteInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    const view = await render(<Harness />)

    await view.getByRole('button', { name: 'Alpha' }).click({ modifiers: ['Meta'] })
    await vi.waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    await view.rerender(<Harness visible={false} />)
    finishOpen(false)
    await settle()

    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })
})
