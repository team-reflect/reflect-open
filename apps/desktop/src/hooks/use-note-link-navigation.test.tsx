import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function route(view: ReturnType<typeof render>): unknown {
  return JSON.parse(view.getByTestId('route').textContent ?? 'null')
}

beforeEach(() => {
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
})

afterEach(cleanup)

describe('useNoteLinkNavigation', () => {
  it('navigates a plain click in the current window', () => {
    const view = render(<Harness />)

    fireEvent.click(view.getByRole('button', { name: 'Alpha' }))

    expect(route(view)).toEqual({ kind: 'note', path: 'notes/alpha.md' })
    expect(openRouteInNewWindow).not.toHaveBeenCalled()
  })

  it('opens a modifier-click in a secondary window without navigating', async () => {
    const view = render(<Harness />)

    fireEvent.click(view.getByRole('button', { name: 'Alpha' }), { metaKey: true })

    await waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/alpha.md',
      }),
    )
    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })

  it('falls back to current-window navigation when a secondary window is declined', async () => {
    openRouteInNewWindow.mockResolvedValue(false)
    const view = render(<Harness />)

    fireEvent.click(view.getByRole('button', { name: 'Alpha' }), { metaKey: true })

    await waitFor(() =>
      expect(route(view)).toEqual({ kind: 'note', path: 'notes/alpha.md' }),
    )
  })

  it('falls back to current-window navigation when a secondary window open rejects', async () => {
    openRouteInNewWindow.mockRejectedValue(new Error('window creation failed'))
    const view = render(<Harness />)

    fireEvent.click(view.getByRole('button', { name: 'Alpha' }), { metaKey: true })

    await waitFor(() =>
      expect(route(view)).toEqual({ kind: 'note', path: 'notes/alpha.md' }),
    )
  })

  it('does not let an older failed open override a newer note-link intent', async () => {
    let finishOpen: ((opened: boolean) => void) | null = null
    openRouteInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    const view = render(<Harness />)

    fireEvent.click(view.getByRole('button', { name: 'Alpha' }), { metaKey: true })
    await waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    fireEvent.click(view.getByRole('button', { name: 'Bravo' }))
    expect(route(view)).toEqual({ kind: 'note', path: 'notes/bravo.md' })

    await act(async () => {
      finishOpen?.(false)
    })

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
    const view = render(<Harness />)

    fireEvent.click(view.getByRole('button', { name: 'Alpha' }), { metaKey: true })
    await waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    fireEvent.click(view.getByRole('button', { name: 'Bravo' }), { metaKey: true })
    await waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(2))

    await act(async () => {
      rejectOpen(new Error('window creation failed'))
    })

    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })

  it('does not fall back after another control re-navigates to the same route', async () => {
    let finishOpen: ((opened: boolean) => void) | null = null
    openRouteInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    const view = render(<Harness />)

    fireEvent.click(view.getByRole('button', { name: 'Alpha' }), { metaKey: true })
    await waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    fireEvent.click(view.getByRole('button', { name: 'Reopen current route' }))
    await act(async () => {
      finishOpen?.(false)
    })

    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })

  it('does not fall back after the host surface changes scope', async () => {
    let finishOpen: ((opened: boolean) => void) | null = null
    openRouteInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    const view = render(<Harness scopeKey="2026-07-10" />)

    fireEvent.click(view.getByRole('button', { name: 'Alpha' }), { metaKey: true })
    await waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    view.rerender(<Harness scopeKey="2026-07-11" />)
    await act(async () => {
      finishOpen?.(false)
    })

    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })

  it('does not navigate after the link host unmounts', async () => {
    let finishOpen: ((opened: boolean) => void) | null = null
    openRouteInNewWindow.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      }),
    )
    const view = render(<Harness />)

    fireEvent.click(view.getByRole('button', { name: 'Alpha' }), { metaKey: true })
    await waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalledTimes(1))
    view.rerender(<Harness visible={false} />)
    await act(async () => {
      finishOpen?.(false)
    })

    expect(route(view)).toEqual({ kind: 'allNotes', tag: null })
  })
})
