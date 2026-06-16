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
  navigate: (route: Route) => void
  back: () => void
  forward: () => void
  canBack: boolean
  canForward: boolean
  /** Record the active view's scroll offset on the current history entry. */
  saveScrollState: (offset: number) => void
  /** The current entry's recorded offset (present when revisited), or `null`. */
  savedScroll: () => number | null
}

const RouterContext = createContext<RouterValue | null>(null)

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
  const nextId = useRef(1)
  /** Scroll offsets by entry id — a ref so scroll reporting never re-renders. */
  const scrollById = useRef(new Map<number, number>())
  /** The active entry id, readable without depending on render order. */
  const currentId = useRef(0)
  // Written during render, not in an effect: descendant scroll-restoration
  // effects read this id (through saveScrollState/savedScroll) on the same
  // commit, and React runs effects child-before-parent — so updating it in an
  // effect here would lag a frame and restore or save the wrong entry's offset.
  // eslint-disable-next-line react-hooks/refs
  currentId.current = history.stack[history.index]!.id

  const navigate = useCallback((route: Route) => {
    const target = normalizeRoute(route)
    setHistory((current) => {
      const currentEntry = current.stack[current.index]!
      if (routesEqual(currentEntry.route, target)) {
        // No stack growth — but this is still an explicit arrival: forget the
        // entry's saved offset so the view re-anchors to its target instead of
        // restoring the old scroll position.
        scrollById.current.delete(currentEntry.id)
        return current
      }
      const dropped = current.stack.slice(current.index + 1)
      for (const entry of dropped) {
        scrollById.current.delete(entry.id) // truncated branch — free its offsets
      }
      const stack = [
        ...current.stack.slice(0, current.index + 1),
        { id: nextId.current++, route: target },
      ]
      return { stack, index: stack.length - 1 }
    })
    setArrivalSeq((seq) => seq + 1)
  }, [])

  const back = useCallback(() => {
    setHistory((current) =>
      current.index > 0 ? { ...current, index: current.index - 1 } : current,
    )
  }, [])

  const forward = useCallback(() => {
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
      navigate,
      back,
      forward,
      canBack: history.index > 0,
      canForward: history.index < history.stack.length - 1,
      saveScrollState,
      savedScroll,
    }
  }, [history, arrivalSeq, navigate, back, forward, saveScrollState, savedScroll])

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
