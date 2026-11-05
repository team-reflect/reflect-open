import {
  createContext,
  startTransition,
  useCallback,
  use,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import type {
  NavigateOptions,
  NavigationService,
  NavigationState,
  Route,
  ScrollPosition,
} from '@reflect/app'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

export type RouterNavigate = (route: Route, options?: NavigateOptions) => void

/**
 * The app router (Plan 06): the React face of core's `NavigationService`, a
 * history stack over typed {@link Route}s — no URL, no dependency. Mount it
 * per graph (keyed by the graph root) so switching graphs starts a fresh
 * history.
 */

/**
 * The history entry on screen and the state around it.
 */
type RouterState = NavigationState

/**
 * The scroll callbacks, bound to the history entry the subtree renders.
 */
interface RouterHandlers {
  /** Record the active view's scroll position on the history entry it renders. */
  saveScrollState: (position: ScrollPosition) => void
  /**
   * Discard the current view's saved scroll positions — the active history
   * entry's and, when the route belongs to a long-lived surface, the surface's
   * too — so the view re-anchors when revisited through **any** door (⌘[ back
   * or a `restoreSurfaceScroll` nav-tab return alike).
   */
  clearScrollState: () => void
  /** The rendered entry's recorded position (present when revisited), or `null`. */
  savedScroll: () => ScrollPosition | null
}

/**
 * The router's navigation callbacks, stable for the provider's lifetime.
 */
interface RouterActions {
  navigate: RouterNavigate
  back: () => void
  forward: () => void
}

const RouterStateContext = createContext<RouterState | null>(null)
const RouterHandlersContext = createContext<RouterHandlers | null>(null)
const RouterActionsContext = createContext<RouterActions | null>(null)

interface RouterProviderProps {
  /** The launch route; defaults to today (the daily note is the spine). */
  initialRoute?: Route | undefined
  children: ReactNode
}

/**
 * Thin React shell over the app's `NavigationService`, which owns the history.
 * Each mount starts a fresh history on `initialRoute`. Navigation runs inside
 * a transition, so the screen on show stays up while the next one loads.
 */
export function RouterProvider({
  initialRoute = { kind: 'today' },
  children,
}: RouterProviderProps): ReactElement {
  const { navigation: appNavigation } = useAppServices()
  const [navigation] = useState(() => {
    appNavigation.reset(initialRoute)
    return appNavigation
  })

  return (
    <RouterActionsProvider navigation={navigation}>
      <RouterStateProvider navigation={navigation}>
        <RouterHandlersProvider navigation={navigation}>{children}</RouterHandlersProvider>
      </RouterStateProvider>
    </RouterActionsProvider>
  )
}

interface NavigationProviderProps {
  navigation: NavigationService
  children: ReactNode
}

/**
 * Provides the navigation callbacks. Each one runs the service call inside a
 * transition, so the `setState` its subscriber fires is a transition update.
 */
function RouterActionsProvider({ navigation, children }: NavigationProviderProps): ReactElement {
  const navigate = useCallback(
    (route: Route, options?: NavigateOptions): void => {
      startTransition(() => {
        return navigation.navigate(route, options)
      })
    },
    [navigation],
  )

  const back = useCallback((): void => {
    startTransition(() => {
      navigation.back()
    })
  }, [navigation])

  const forward = useCallback((): void => {
    startTransition(() => {
      navigation.forward()
    })
  }, [navigation])

  const routerActions = useMemo<RouterActions>(
    () => ({ navigate, back, forward }),
    [navigate, back, forward],
  )

  return <RouterActionsContext value={routerActions}>{children}</RouterActionsContext>
}

/**
 * Provides the service's state as rendered by React.
 */
function RouterStateProvider({ navigation, children }: NavigationProviderProps): ReactElement {
  const { noteMove } = useCoreServices()
  // React state rather than `useSyncExternalStore`: a store read through that
  // hook always updates synchronously, which would drop the transition and
  // flash the loading fallback of every lazily loaded screen.
  const [state, setState] = useState(() => navigation.get())

  useEffect(() => {
    const sync = (): void => setState(navigation.get())
    const unsubscribe = navigation.subscribe(sync)
    // A descendant's effect may have navigated before this subscription.
    startTransition(sync)
    return unsubscribe
  }, [navigation])

  // A note file move (Plan 17) rewrites every history entry that points at
  // the old path, so the current route (and back/forward) follow the file.
  useEffect(() => {
    return noteMove.onMoved((from, to) => navigation.noteMoved(from, to))
  }, [navigation, noteMove])

  return <RouterStateContext value={state}>{children}</RouterStateContext>
}

/**
 * Provides the scroll callbacks for the entry in the router state above it.
 */
function RouterHandlersProvider({ navigation, children }: NavigationProviderProps): ReactElement {
  // The scroll callbacks are bound to the entry this render shows. The
  // service's current entry runs ahead of the screen while a transition is
  // pending, and a render that suspends never commits, so neither can tell
  // which entry the views on screen belong to.
  const { entryId, route } = useRouterState()
  const position = useMemo(() => ({ entryId, route }), [entryId, route])
  const saveScrollState = useCallback(
    (scroll: ScrollPosition) => {
      navigation.saveScrollState(scroll, position)
    },
    [navigation, position],
  )
  const clearScrollState = useCallback(() => {
    navigation.clearScrollState(position)
  }, [navigation, position])
  const savedScroll = useCallback(() => {
    return navigation.savedScroll(position)
  }, [navigation, position])

  const routerHandlers = useMemo<RouterHandlers>(() => {
    return { saveScrollState, clearScrollState, savedScroll }
  }, [saveScrollState, clearScrollState, savedScroll])

  return <RouterHandlersContext value={routerHandlers}>{children}</RouterHandlersContext>
}

/** Access the current route state. Use within a RouterProvider. */
export function useRouterState(): RouterState {
  const context = use(RouterStateContext)
  if (!context) {
    throw new Error('useRouterState must be used within a RouterProvider')
  }
  return context
}

/**
 * Access the scroll callbacks for the history entry on screen. Use within a
 * RouterProvider.
 */
export function useRouterHandlers(): RouterHandlers {
  const context = use(RouterHandlersContext)
  if (!context) {
    throw new Error('useRouterHandlers must be used within a RouterProvider')
  }
  return context
}

/**
 * Access the navigation callbacks without subscribing to route changes. Use
 * within a RouterProvider.
 */
export function useRouterActions(): RouterActions {
  const context = use(RouterActionsContext)
  if (!context) {
    throw new Error('useRouterActions must be used within a RouterProvider')
  }
  return context
}

interface RouterFreezeProps {
  /** While true, the subtree keeps the last router state it saw unfrozen. */
  frozen: boolean
  children: ReactNode
}

/**
 * Pin the router state a subtree sees while it is in the background. The
 * mobile stack keeps the screen `back()` would reveal mounted (hidden and
 * inert) beneath a note — without this, that screen would still observe
 * every navigation: a note push bumps `arrivalSeq`, which the daily surface
 * reads as a re-arrival and re-anchors its scroll while nobody is looking.
 * Frozen subtrees resume the live state the moment they surface again. The
 * scroll handlers are pinned with the state, so they keep pointing at the
 * entry the subtree shows. The navigation callbacks are not frozen: they are
 * stable for the provider's lifetime.
 */
export function RouterFreeze({ frozen, children }: RouterFreezeProps): ReactElement {
  const liveState = useRouterState()
  const liveHandlers = useRouterHandlers()
  // The capture tracks the live values only while unfrozen — state adjusted
  // during render, so freezing pins exactly what the last unfrozen commit saw.
  const [captured, setCaptured] = useState({ state: liveState, handlers: liveHandlers })
  if (!frozen && (captured.state !== liveState || captured.handlers !== liveHandlers)) {
    setCaptured({ state: liveState, handlers: liveHandlers })
  }
  const pinned = frozen ? captured : { state: liveState, handlers: liveHandlers }
  return (
    <RouterStateContext value={pinned.state}>
      <RouterHandlersContext value={pinned.handlers}>{children}</RouterHandlersContext>
    </RouterStateContext>
  )
}
