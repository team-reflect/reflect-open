import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { renderHookInApp, renderInApp } from '@/test-utils/render-in-app.tsx'
import type { Route } from './route.ts'
import { RouterFreeze, useRouter } from './router.tsx'

/**
 * `useRouter()` under the app's `RouterProvider`, mounted on `initialRoute`.
 */
function routerHook(initialRoute?: Route, app: TestCoreServices = createTestCoreServices()) {
  return renderHookInApp(() => useRouter(), {
    app,
    ...(initialRoute === undefined ? {} : { route: initialRoute }),
  })
}

// The history itself is covered by the app layer's `navigation-service.test.ts`; these
// cover the React shell over it.
describe('router', () => {
  it('starts on today with no history', async () => {
    const { result } = await routerHook()
    expect(result.current.route).toEqual({ kind: 'today' })
    expect(result.current.canBack).toBe(false)
    expect(result.current.canForward).toBe(false)
  })

  it('starts on the initial route, normalized', async () => {
    const { result } = await routerHook({ kind: 'daily', date: 'not-a-date' })
    expect(result.current.route).toEqual({ kind: 'today' })
  })

  it('renders the navigation service through navigate, back, and forward', async () => {
    const { result, act, appServices } = await routerHook()
    await act(() => result.current.navigate({ kind: 'daily', date: '2026-06-08' }))
    await act(() =>
      result.current.navigate({ kind: 'note', path: 'notes/a.md' }, { focusEditor: true }),
    )
    expect(result.current.route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(result.current.arrivalSeq).toBe(2)
    expect(result.current.arrivalFocusEditor).toBe(true)
    expect(result.current.backRoute).toEqual({ kind: 'daily', date: '2026-06-08' })
    expect(appServices.navigation.getState().route).toEqual({ kind: 'note', path: 'notes/a.md' })

    await act(() => result.current.back())
    expect(result.current.route).toEqual({ kind: 'daily', date: '2026-06-08' })
    expect(result.current.canForward).toBe(true)

    await act(() => result.current.forward())
    expect(result.current.route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(result.current.canForward).toBe(false)
  })

  it('follows navigation made on the service itself', async () => {
    const { result, act, appServices } = await routerHook()
    await act(() => appServices.navigation.navigate({ kind: 'tasks' }))
    expect(result.current.route).toEqual({ kind: 'tasks' })
  })

  it('a new mount starts a fresh history', async () => {
    const first = await routerHook()
    await first.act(() => first.result.current.navigate({ kind: 'tasks' }))
    await first.act(() => first.result.current.saveScrollState(40))
    await first.unmount()

    const { result } = await routerHook(undefined, first.app)
    expect(result.current.route).toEqual({ kind: 'today' })
    expect(result.current.canBack).toBe(false)
    expect(result.current.arrivalSeq).toBe(0)
    expect(result.current.savedScroll()).toBeNull()
  })

  it('restores a saved scroll offset on back/forward, per entry', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.saveScrollState(120)) // scrolling on today
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    expect(result.current.savedScroll()).toBeNull() // fresh entry: no offset yet

    await act(() => result.current.saveScrollState(40))
    await act(() => result.current.back())
    expect(result.current.savedScroll()).toBe(120) // today's offset restored

    await act(() => result.current.forward())
    expect(result.current.savedScroll()).toBe(40) // the note's own offset
  })

  it('can clear the active entry scroll offset without changing routes', async () => {
    const { result, act } = await routerHook()
    const entryId = result.current.entryId
    const arrivals = result.current.arrivalSeq
    await act(() => result.current.saveScrollState(120))

    await act(() => result.current.clearScrollState())

    expect(result.current.route).toEqual({ kind: 'today' })
    expect(result.current.entryId).toBe(entryId)
    expect(result.current.arrivalSeq).toBe(arrivals)
    expect(result.current.savedScroll()).toBeNull()
  })

  it('RouterFreeze pins what a background subtree sees until it surfaces', async () => {
    let router: ReturnType<typeof useRouter> | null = null
    function Capture(): null {
      router = useRouter()
      return null
    }
    function Probe(): ReactElement {
      const { route, arrivalSeq } = useRouter()
      return <div data-testid="frozen-probe">{`${route.kind}:${arrivalSeq}`}</div>
    }
    function Harness({ frozen }: { frozen: boolean }): ReactElement {
      return (
        <>
          <Capture />
          <RouterFreeze frozen={frozen}>
            <Probe />
          </RouterFreeze>
        </>
      )
    }

    const view = await renderInApp(<Harness frozen={false} />)
    await expect.element(view.getByTestId('frozen-probe')).toMatchTextContent('today:0')

    // Covered by a pushed note (the mobile stack hides it): navigations must
    // not reach it — the daily surface would read the arrivalSeq bump as a
    // re-arrival and re-anchor its scroll while hidden.
    await view.rerender(<Harness frozen={true} />)
    router!.navigate({ kind: 'note', path: 'notes/a.md' })
    await expect.element(view.getByTestId('frozen-probe')).toMatchTextContent('today:0')

    // Surfacing again resumes the live value.
    await view.rerender(<Harness frozen={false} />)
    await expect.element(view.getByTestId('frozen-probe')).toMatchTextContent('note:1')
  })

  describe('note moves (Plan 17)', () => {
    it('rewrites the current route when a note moves', async () => {
      const { result, act, app } = await routerHook()
      await act(() => result.current.navigate({ kind: 'note', path: 'notes/01abc.md' }))
      const arrivalsBefore = result.current.arrivalSeq
      const entryBefore = result.current.entryId

      await act(() => app.noteMove.followHealedMove('notes/01abc.md', 'notes/meeting-notes.md'))

      expect(result.current.route).toEqual({ kind: 'note', path: 'notes/meeting-notes.md' })
      expect(result.current.arrivalSeq).toBe(arrivalsBefore)
      expect(result.current.entryId).toBe(entryBefore)
    })

    it('a move settling after the workspace unmounts is harmless', async () => {
      const { result, act, unmount, app } = await routerHook()
      await act(() => result.current.navigate({ kind: 'note', path: 'notes/01abc.md' }))
      await unmount()

      app.noteMove.followHealedMove('notes/01abc.md', 'notes/meeting-notes.md')
    })
  })
})
