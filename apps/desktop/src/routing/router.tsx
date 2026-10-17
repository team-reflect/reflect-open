import {
  createContext,
  startTransition,
  useCallback,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { NavigateOptions } from '@reflect/app'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import type { Route } from './route.ts'

export type RouterNavigate = (route: Route, options?: NavigateOptions) => void

/**
 * The app router (Plan 06): the React face of core's `NavigationService`, a
 * history stack over typed {@link Route}s — no URL, no dependency. Mount it
 * per graph (keyed by the graph root) so switching graphs starts a fresh
 * history.
 */

interface RouterValue {
  route: Route
  /** Stable identity of the current history entry (changes on back/forward). */
  entryId: number
  /**
   * Increments on every `navigate` call — including a no-op re-navigation to
   * the current route — so views can re-anchor on explicit intent (e.g. ⌘D
   * while already on today re-scrolls the stream to today).
   */
  arrivalSeq: number
  /**
   * True when the latest arrival asked the destination to focus its primary
   * input (`navigate(route, { focusEditor: true })`). Only explicit capture
   * gestures request it — the mobile Daily-, All-, Tasks-, and Chat-tab
   * double-taps, desktop's ⌘D and sidebar Daily notes row — while note
   * navigations (wiki links, backlinks, back/forward) stay calm so the
   * keyboard never rises mid-arrival.
   * One-shot by construction: the next navigate overwrites it and history
   * moves clear it, so it can never leak onto a later, unrelated arrival.
   */
  arrivalFocusEditor: boolean
  navigate: RouterNavigate
  back: () => void
  forward: () => void
  canBack: boolean
  canForward: boolean
  /**
   * The route `back()` would land on — the entry just below the current one —
   * or `null` at the bottom of the stack. The mobile stack renders it beneath
   * a pushed note so the back-swipe gesture reveals a live screen.
   */
  backRoute: Route | null
  /** Record the active view's scroll offset on the current history entry. */
  saveScrollState: (offset: number) => void
  /**
   * Discard the current view's saved scroll offsets — the active history
   * entry's and, when the route belongs to a long-lived surface, the surface's
   * too — so the view re-anchors when revisited through **any** door (⌘[ back
   * or a `restoreSurfaceScroll` nav-tab return alike).
   */
  clearScrollState: () => void
  /** The current entry's recorded offset (present when revisited), or `null`. */
  savedScroll: () => number | null
}

const RouterContext = createContext<RouterValue | null>(null)

export type { NavigateOptions }

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
  const { noteMove } = useCoreServices()
  const [navigation] = useState(() => {
    appNavigation.reset(initialRoute)
    return appNavigation
  })
  // React state rather than `useSyncExternalStore`: a store read through that
  // hook always updates synchronously, which would drop the transition and
  // flash the loading fallback of every lazily loaded screen.
  const [state, setState] = useState(() => navigation.getState())
  /**
   * The state on screen, readable from scroll handlers without re-rendering.
   */
  const renderedRef = useRef(state)
  // Written during render, not in an effect: descendant scroll-restoration
  // effects read this (through saveScrollState/savedScroll) on the same
  // commit, and React runs effects child-before-parent — so updating it in an
  // effect here would lag a frame and restore or save the wrong entry's offset.
  // eslint-disable-next-line react-hooks/refs
  renderedRef.current = state

  useEffect(() => {
    const sync = (): void => setState(navigation.getState())
    const unsubscribe = navigation.subscribe(sync)
    // A descendant's effect may have navigated before this subscription.
    startTransition(sync)
    return unsubscribe
  }, [navigation])

  const navigate = useCallback(
    (route: Route, options?: NavigateOptions): void => {
      startTransition(() => navigation.navigate(route, options))
    },
    [navigation],
  )

  const back = useCallback((): void => {
    startTransition(() => navigation.back())
  }, [navigation])

  const forward = useCallback((): void => {
    startTransition(() => navigation.forward())
  }, [navigation])

  // A note file move (Plan 17) rewrites every history entry that points at
  // the old path, so the current route (and back/forward) follow the file.
  useEffect(
    () => noteMove.onMoved((from, to) => navigation.noteMoved(from, to)),
    [navigation, noteMove],
  )

  const saveScrollState = useCallback(
    (offset: number) => navigation.saveScrollState(offset, renderedRef.current),
    [navigation],
  )
  const clearScrollState = useCallback(
    () => navigation.clearScrollState(renderedRef.current),
    [navigation],
  )
  const savedScroll = useCallback(() => navigation.savedScroll(renderedRef.current), [navigation])

  const value = useMemo<RouterValue>(
    () => ({
      route: state.route,
      entryId: state.entryId,
      arrivalSeq: state.arrivalSeq,
      arrivalFocusEditor: state.arrivalFocusEditor,
      navigate,
      back,
      forward,
      canBack: state.canBack,
      canForward: state.canForward,
      backRoute: state.backRoute,
      saveScrollState,
      clearScrollState,
      savedScroll,
    }),
    [state, navigate, back, forward, saveScrollState, clearScrollState, savedScroll],
  )

  return <RouterContext value={value}>{children}</RouterContext>
}

/** Access the current route + navigation. Use within a RouterProvider. */
export function useRouter(): RouterValue {
  const context = use(RouterContext)
  if (!context) {
    throw new Error('useRouter must be used within a RouterProvider')
  }
  return context
}

interface RouterFreezeProps {
  /** While true, the subtree keeps the last router value it saw unfrozen. */
  frozen: boolean
  children: ReactNode
}

/**
 * Pin the router value a subtree sees while it is in the background. The
 * mobile stack keeps the screen `back()` would reveal mounted (hidden and
 * inert) beneath a note — without this, that screen would still observe
 * every navigation: a note push bumps `arrivalSeq`, which the daily surface
 * reads as a re-arrival and re-anchors its scroll while nobody is looking.
 * Frozen subtrees resume the live value the moment they surface again; the
 * navigation callbacks in the frozen snapshot stay valid because they are
 * stable for the provider's lifetime.
 */
export function RouterFreeze({ frozen, children }: RouterFreezeProps): ReactElement {
  const live = useRouter()
  // The capture tracks the live value only while unfrozen — state adjusted
  // during render, so freezing pins exactly what the last unfrozen commit saw.
  const [captured, setCaptured] = useState(live)
  if (!frozen && captured !== live) {
    setCaptured(live)
  }
  return <RouterContext value={frozen ? captured : live}>{children}</RouterContext>
}
