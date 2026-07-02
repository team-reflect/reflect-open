import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { onNoteMoved } from '@/lib/note-moves'
import { normalizeRoute, routesEqual, type Route } from './route'

/**
 * The app router (Plan 06): a history stack over typed {@link Route}s — no URL,
 * no dependency. `navigate` pushes (truncating any forward entries, like a
 * browser), `back`/`forward` move the cursor. Mount it per graph (keyed by the
 * graph root) so switching graphs starts a fresh history.
 *
 * Each history entry can carry a **scroll offset** (Plan 06b): views report
 * theirs via `saveScrollState` (a ref write — safe from scroll handlers, never
 * re-renders) and read `savedScroll()` after a back/forward restores an entry.
 *
 * Long-lived surfaces (the daily stream, shared by the today/daily routes)
 * additionally keep a **surface offset** — the last reported position,
 * independent of any history entry — so a nav-tab return can resume the stream
 * where the user left it (`restoreSurfaceScroll`) even though it lands on a
 * fresh entry.
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
   * True when the latest arrival asked the destination to focus its editor
   * (`navigate(route, { focusEditor: true })`) — the mobile focus contract
   * (Plan 19): a wiki-link or backlink tap restores focus (and the keyboard)
   * on the destination note, while plain arrivals and back/forward stay calm.
   * One-shot by construction: the next navigate overwrites it and history
   * moves clear it, so it can never leak onto a later, unrelated arrival.
   */
  arrivalFocusEditor: boolean
  navigate: (route: Route, options?: NavigateOptions) => void
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

export interface NavigateOptions {
  /**
   * Seed the new history entry with the last saved scroll position of the
   * target route's surface. Primary nav tabs use this so switching away and
   * back does not reset long-lived list surfaces. Only a genuine return
   * honors it: when the current route already sits on the target's surface
   * the arrival re-anchors like any other explicit navigation, and ordinary
   * command arrivals omit it and re-anchor as before.
   */
  restoreSurfaceScroll?: boolean
  /**
   * Ask the destination to focus its editor on arrival — see
   * {@link RouterValue.arrivalFocusEditor}. Consumed by the mobile note
   * screen; desktop's note route autofocuses every arrival and ignores it.
   */
  focusEditor?: boolean
}

/**
 * The scroll-surface key for routes whose view outlives any single history
 * entry, or `null` for ordinary per-entry restoration. Today and dated daily
 * routes share one stream, hence one key.
 */
function scrollSurfaceForRoute(route: Route): string | null {
  switch (route.kind) {
    case 'today':
    case 'daily':
      return 'daily'
    default:
      return null
  }
}

interface RouterProviderProps {
  /** The launch route; defaults to today (the daily note is the spine). */
  initialRoute?: Route | undefined
  children: ReactNode
}

interface HistoryEntry {
  /** Stable identity for scroll bookkeeping (indices shift on truncation). */
  id: number
  route: Route
}

interface HistoryState {
  stack: HistoryEntry[]
  index: number
}

export function RouterProvider({
  initialRoute = { kind: 'today' },
  children,
}: RouterProviderProps): ReactElement {
  const [history, setHistory] = useState<HistoryState>({
    stack: [{ id: 0, route: normalizeRoute(initialRoute) }],
    index: 0,
  })
  const [arrivalSeq, setArrivalSeq] = useState(0)
  const [arrivalFocusEditor, setArrivalFocusEditor] = useState(false)
  const nextId = useRef(1)
  /** Scroll offsets by entry id — a ref so scroll reporting never re-renders. */
  const scrollById = useRef(new Map<number, number>())
  /** Last offset per long-lived surface, independent of history entries. */
  const scrollBySurface = useRef(new Map<string, number>())
  /** The active entry id, readable without depending on render order. */
  const currentId = useRef(0)
  /** The active route, readable from scroll handlers without re-rendering. */
  const currentRoute = useRef<Route>(history.stack[history.index]!.route)
  // Written during render, not in an effect: descendant scroll-restoration
  // effects read this id (through saveScrollState/savedScroll) on the same
  // commit, and React runs effects child-before-parent — so updating it in an
  // effect here would lag a frame and restore or save the wrong entry's offset.
  // eslint-disable-next-line react-hooks/refs
  currentId.current = history.stack[history.index]!.id
  // eslint-disable-next-line react-hooks/refs
  currentRoute.current = history.stack[history.index]!.route

  const navigate = useCallback((route: Route, options?: NavigateOptions) => {
    const target = normalizeRoute(route)
    const surface = scrollSurfaceForRoute(target)
    // A surface restore only means something when coming from OFF the surface;
    // the Daily tab clicked while already on the stream is an explicit
    // re-anchor request, exactly like ⌘D.
    const returning =
      options?.restoreSurfaceScroll === true &&
      surface !== null &&
      scrollSurfaceForRoute(currentRoute.current) !== surface
    const restored = returning ? scrollBySurface.current.get(surface) : undefined
    if (surface !== null && restored === undefined) {
      // An explicit arrival re-anchors the surface, making its saved offset
      // stale — drop it so a later nav-tab return re-anchors too instead of
      // resurrecting the pre-arrival position. Scrolling after the arrival
      // repopulates it.
      scrollBySurface.current.delete(surface)
    }
    setHistory((current) => {
      const currentEntry = current.stack[current.index]!
      if (routesEqual(currentEntry.route, target)) {
        if (restored !== undefined) {
          scrollById.current.set(currentEntry.id, restored)
        } else {
          // No stack growth — but this is still an explicit arrival: forget the
          // entry's saved offset so the view re-anchors to its target instead of
          // restoring the old scroll position.
          scrollById.current.delete(currentEntry.id)
        }
        return current
      }
      const dropped = current.stack.slice(current.index + 1)
      for (const entry of dropped) {
        scrollById.current.delete(entry.id) // truncated branch — free its offsets
      }
      const id = nextId.current++
      if (restored !== undefined) {
        scrollById.current.set(id, restored) // seed the fresh entry with the surface offset
      }
      const stack = [...current.stack.slice(0, current.index + 1), { id, route: target }]
      return { stack, index: stack.length - 1 }
    })
    setArrivalSeq((seq) => seq + 1)
    setArrivalFocusEditor(options?.focusEditor === true)
  }, [])

  const back = useCallback(() => {
    setArrivalFocusEditor(false) // history moves are never focus arrivals
    setHistory((current) =>
      current.index > 0 ? { ...current, index: current.index - 1 } : current,
    )
  }, [])

  const forward = useCallback(() => {
    setArrivalFocusEditor(false)
    setHistory((current) =>
      current.index < current.stack.length - 1 ? { ...current, index: current.index + 1 } : current,
    )
  }, [])

  // A note file move (Plan 17) rewrites every history entry that points at
  // the old path — the current route follows the file without an arrival
  // (same entry ids, so scroll offsets and back/forward stay intact), and a
  // back-nav can never land on a path that no longer exists.
  useEffect(
    () =>
      onNoteMoved((from, to) => {
        setHistory((current) => {
          let changed = false
          const stack = current.stack.map((entry) => {
            if (entry.route.kind === 'note' && entry.route.path === from) {
              changed = true
              return { ...entry, route: { kind: 'note' as const, path: to } }
            }
            return entry
          })
          return changed ? { ...current, stack } : current
        })
      }),
    [],
  )

  const saveScrollState = useCallback((offset: number) => {
    scrollById.current.set(currentId.current, offset)
    const surface = scrollSurfaceForRoute(currentRoute.current)
    if (surface !== null) {
      scrollBySurface.current.set(surface, offset)
    }
  }, [])

  const clearScrollState = useCallback(() => {
    scrollById.current.delete(currentId.current)
    const surface = scrollSurfaceForRoute(currentRoute.current)
    if (surface !== null) {
      scrollBySurface.current.delete(surface)
    }
  }, [])

  const savedScroll = useCallback(
    () => scrollById.current.get(currentId.current) ?? null,
    [],
  )

  const value = useMemo<RouterValue>(() => {
    const entry = history.stack[history.index]!
    return {
      route: entry.route,
      entryId: entry.id,
      arrivalSeq,
      arrivalFocusEditor,
      navigate,
      back,
      forward,
      canBack: history.index > 0,
      canForward: history.index < history.stack.length - 1,
      backRoute: history.index > 0 ? history.stack[history.index - 1]!.route : null,
      saveScrollState,
      clearScrollState,
      savedScroll,
    }
  }, [
    history,
    arrivalSeq,
    arrivalFocusEditor,
    navigate,
    back,
    forward,
    saveScrollState,
    clearScrollState,
    savedScroll,
  ])

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

/** Access the current route + navigation. Use within a RouterProvider. */
export function useRouter(): RouterValue {
  const context = useContext(RouterContext)
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
  return (
    <RouterContext.Provider value={frozen ? captured : live}>{children}</RouterContext.Provider>
  )
}
