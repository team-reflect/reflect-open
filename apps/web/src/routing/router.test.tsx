import { act } from '@/test-utils/act.ts'
import { describe, expect, it } from 'vitest'
import { Suspense, use, useEffect, type ReactElement } from 'react'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { renderHookInApp, renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import type { Route } from '@reflect/app'
import { RouterFreeze, useRouterActions, useRouterHandlers, useRouterState } from './router.tsx'
import { noop } from '@ocavue/utils'

/**
 * The router state, handlers, and actions under the app's `RouterProvider`, mounted on
 * `initialRoute`.
 */
function routerHook(
  initialRoute?: Route,
  core: TestCoreServices = createTestCoreServices({ database: createWasmTestDatabaseService() }),
) {
  return renderHookInApp(
    () => ({
      state: useRouterState(),
      handlers: useRouterHandlers(),
      actions: useRouterActions(),
    }),
    {
      core,
      ...(initialRoute === undefined ? {} : { route: initialRoute }),
    },
  )
}

// The history itself is covered by the app layer's `navigation-service.test.ts`; these
// cover the React shell over it.
describe('router', () => {
  it('starts on today with no history', async () => {
    const { result } = await routerHook()
    expect(result.current.state.route).toEqual({ kind: 'today' })
    expect(result.current.state.canBack).toBe(false)
    expect(result.current.state.canForward).toBe(false)
  })

  it('starts on the initial route, normalized', async () => {
    const { result } = await routerHook({ kind: 'daily', date: 'not-a-date' })
    expect(result.current.state.route).toEqual({ kind: 'today' })
  })

  it('renders the navigation service through navigate, back, and forward', async () => {
    const { result, appServices } = await routerHook()
    await act(() => result.current.actions.navigate({ kind: 'daily', date: '2026-06-08' }))
    await act(() => {
      result.current.actions.navigate({ kind: 'note', path: 'notes/a.md' }, { focusEditor: true })
    })
    expect(result.current.state.route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(result.current.state.arrivalSeq).toBe(2)
    expect(result.current.state.arrivalFocusEditor).toBe(true)
    expect(result.current.state.backRoute).toEqual({ kind: 'daily', date: '2026-06-08' })
    expect(appServices.navigation.get().route).toEqual({ kind: 'note', path: 'notes/a.md' })

    await act(() => result.current.actions.back())
    expect(result.current.state.route).toEqual({ kind: 'daily', date: '2026-06-08' })
    expect(result.current.state.canForward).toBe(true)

    await act(() => result.current.actions.forward())
    expect(result.current.state.route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(result.current.state.canForward).toBe(false)
  })

  it('follows navigation made on the service itself', async () => {
    const { result, appServices } = await routerHook()
    await act(() => appServices.navigation.navigate({ kind: 'tasks' }))
    expect(result.current.state.route).toEqual({ kind: 'tasks' })
  })

  it('a new mount starts a fresh history', async () => {
    const first = await routerHook()
    await act(() => first.result.current.actions.navigate({ kind: 'tasks' }))
    await act(() => first.result.current.handlers.saveScrollState(40))
    await first.unmount()

    const { result } = await routerHook(undefined, first.core)
    expect(result.current.state.route).toEqual({ kind: 'today' })
    expect(result.current.state.canBack).toBe(false)
    expect(result.current.state.arrivalSeq).toBe(0)
    expect(result.current.handlers.savedScroll()).toBeNull()
  })

  it('restores a saved scroll offset on back/forward, per entry', async () => {
    const { result } = await routerHook()
    await act(() => result.current.handlers.saveScrollState(120)) // scrolling on today
    await act(() => result.current.actions.navigate({ kind: 'note', path: 'notes/a.md' }))
    expect(result.current.handlers.savedScroll()).toBeNull() // fresh entry: no offset yet

    await act(() => result.current.handlers.saveScrollState(40))
    await act(() => result.current.actions.back())
    expect(result.current.handlers.savedScroll()).toBe(120) // today's offset restored

    await act(() => result.current.actions.forward())
    expect(result.current.handlers.savedScroll()).toBe(40) // the note's own offset
  })

  it('can clear the active entry scroll offset without changing routes', async () => {
    const { result } = await routerHook()
    const entryId = result.current.state.entryId
    const arrivals = result.current.state.arrivalSeq
    await act(() => result.current.handlers.saveScrollState(120))

    await act(() => result.current.handlers.clearScrollState())

    expect(result.current.state.route).toEqual({ kind: 'today' })
    expect(result.current.state.entryId).toBe(entryId)
    expect(result.current.state.arrivalSeq).toBe(arrivals)
    expect(result.current.handlers.savedScroll()).toBeNull()
  })

  it('saves scroll on the entry on screen while a transition is pending', async () => {
    let resolveTasks: () => void = noop
    const tasksReady = new Promise<void>((resolve) => {
      resolveTasks = resolve
    })
    // React subscribes to the promise once a render suspends on it.
    let suspended = false
    const then = tasksReady.then.bind(tasksReady)
    tasksReady.then = (...args) => {
      suspended = true
      return then(...args)
    }
    let committed: ReturnType<typeof useRouterHandlers> | null = null
    let actions: ReturnType<typeof useRouterActions> | null = null
    function Screen(): ReactElement {
      const state = useRouterState()
      const handlers = useRouterHandlers()
      const routerActions = useRouterActions()
      useEffect(() => {
        committed = handlers
        actions = routerActions
      }, [handlers, routerActions])
      if (state.route.kind === 'tasks') {
        use(tasksReady)
      }
      return <div data-testid="screen">{state.route.kind}</div>
    }

    const view = await renderInApp(
      <Suspense fallback={null}>
        <Screen />
      </Suspense>,
    )
    await expect.element(view.getByTestId('screen')).toMatchTextContent('today')

    actions!.navigate({ kind: 'tasks' })
    await expect.poll(() => suspended).toBe(true)
    await expect.element(view.getByTestId('screen')).toMatchTextContent('today')
    committed!.saveScrollState(120) // scrolling today while tasks loads

    resolveTasks()
    await expect.element(view.getByTestId('screen')).toMatchTextContent('tasks')
    expect(committed!.savedScroll()).toBeNull()

    actions!.back()
    await expect.element(view.getByTestId('screen')).toMatchTextContent('today')
    expect(committed!.savedScroll()).toBe(120)
  })

  it('useRouterActions does not re-render on navigation', async () => {
    let renders = 0
    const { result } = await renderHookInApp(() => {
      renders += 1
      return useRouterActions()
    })
    const actions = result.current
    const rendersBefore = renders

    await act(() => actions.navigate({ kind: 'tasks' }))
    await act(() => actions.back())

    expect(renders).toBe(rendersBefore)
    expect(result.current).toBe(actions)
  })

  it('RouterFreeze pins what a background subtree sees until it surfaces', async () => {
    let router: ReturnType<typeof useRouterActions> | null = null
    function Capture(): null {
      router = useRouterActions()
      return null
    }
    function Probe(): ReactElement {
      const { route, arrivalSeq } = useRouterState()
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
      const { result, core } = await routerHook()
      await act(() => result.current.actions.navigate({ kind: 'note', path: 'notes/01abc.md' }))
      const arrivalsBefore = result.current.state.arrivalSeq
      const entryBefore = result.current.state.entryId

      await act(() => core.noteMove.followHealedMove('notes/01abc.md', 'notes/meeting-notes.md'))

      expect(result.current.state.route).toEqual({ kind: 'note', path: 'notes/meeting-notes.md' })
      expect(result.current.state.arrivalSeq).toBe(arrivalsBefore)
      expect(result.current.state.entryId).toBe(entryBefore)
    })

    it('a move settling after the workspace unmounts is harmless', async () => {
      const { result, unmount, core } = await routerHook()
      await act(() => result.current.actions.navigate({ kind: 'note', path: 'notes/01abc.md' }))
      await unmount()

      core.noteMove.followHealedMove('notes/01abc.md', 'notes/meeting-notes.md')
    })
  })
})
