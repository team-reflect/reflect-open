import type { Unlisten } from '@reflect/core'
import { normalizeRoute, routesEqual, type Route } from './route.ts'

/**
 * The app's navigation history (Plan 06): a stack over typed {@link Route}s —
 * no URL, no dependency. `navigate` pushes (truncating any forward entries,
 * like a browser), `back`/`forward` move the cursor.
 *
 * Each history entry can carry a **scroll offset** (Plan 06b): views report
 * theirs via `saveScrollState` (never notifies subscribers — safe from scroll
 * handlers) and read `savedScroll()` after a back/forward restores an entry.
 *
 * Long-lived surfaces (the daily stream, shared by the today/daily routes)
 * additionally keep a **surface offset** — the last reported position,
 * independent of any history entry — so a nav-tab return can resume the stream
 * where the user left it (`restoreSurfaceScroll`) even though it lands on a
 * fresh entry.
 */

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
   * Ask the destination to focus its primary input on arrival — see
   * {@link NavigationState.arrivalFocusEditor}. Consumed by the daily surfaces —
   * the mobile Daily-tab double-tap and desktop's stream (⌘D, the sidebar's
   * Daily notes row), which land the caret at the end of the day's content
   * (append-style capture) — and by the mobile All, Tasks, and Chat tabs,
   * whose double-taps focus their primary inputs; desktop's note route
   * autofocuses every arrival and ignores it.
   */
  focusEditor?: boolean
}

/**

 * An immutable snapshot of the history position; replaced on every change.

 */
export interface NavigationState {
  readonly route: Route
  /**
   * Stable identity of the current history entry (changes on back/forward).
   */
  readonly entryId: number
  /**
   * Increments on every `navigate` call — including a no-op re-navigation to
   * the current route — so views can re-anchor on explicit intent (e.g. ⌘D
   * while already on today re-scrolls the stream to today).
   */
  readonly arrivalSeq: number
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
  readonly arrivalFocusEditor: boolean
  readonly canBack: boolean
  readonly canForward: boolean
  /**
   * The route `back()` would land on — the entry just below the current one —
   * or `null` at the bottom of the stack. The mobile stack renders it beneath
   * a pushed note so the back-swipe gesture reveals a live screen.
   */
  readonly backRoute: Route | null
}

/**
 * The history entry a view is showing. A view that renders behind the service
 * (a pending transition) passes the state it rendered, so its scroll
 * bookkeeping lands on the entry on screen rather than the one arriving.
 */
export type NavigationPosition = Pick<NavigationState, 'entryId' | 'route'>

export interface NavigationService {
  /**
   * The current snapshot; the same object until the next change.
   */
  getState(): NavigationState
  /**
   * Hear every state change, synchronously. Scroll bookkeeping does not notify.
   */
  subscribe(listener: () => void): Unlisten
  navigate(route: Route, options?: NavigateOptions): void
  back(): void
  forward(): void
  /**
   * Read the synchronous, monotonic navigation-state revision. It advances on
   * every `navigate`, on every `back` or `forward` that moves, when the
   * current note follows a rename, and on `reset`, so async link fallbacks can
   * detect even a same-route arrival or a back/forward round trip that
   * returned to the same history entry. A back/forward at a history boundary
   * changes nothing and does not advance it.
   */
  navigationRevision(): number
  /**
   * Record a view's scroll offset on its history entry (the current one by default).
   */
  saveScrollState(offset: number, at?: NavigationPosition): void
  /**
   * Discard a view's saved scroll offsets — its history entry's and, when the
   * route belongs to a long-lived surface, the surface's too — so the view
   * re-anchors when revisited through **any** door (⌘[ back or a
   * `restoreSurfaceScroll` nav-tab return alike).
   */
  clearScrollState(at?: NavigationPosition): void
  /**
   * The entry's recorded offset (present when revisited), or `null`.
   */
  savedScroll(at?: NavigationPosition): number | null
  /**
   * A note file moved (Plan 17): rewrite every history entry that points at
   * the old path — the current route follows the file without an arrival
   * (same entry ids, so scroll offsets and back/forward stay intact), and a
   * back-nav can never land on a path that no longer exists.
   */
  noteMoved(from: string, to: string): void
  /**
   * Start a fresh history on `initialRoute` (today by default), dropping every
   * entry and scroll offset: switching graphs must not carry the old graph's
   * history. The view tree that mounts for the new history calls this while it
   * renders, so subscribers are not notified; read `getState()` afterwards.
   */
  reset(initialRoute?: Route): void
}

export interface NavigationServiceDeps {
  /**
   * The launch route; defaults to today (the daily note is the spine).
   */
  readonly initialRoute?: Route | undefined
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

interface HistoryEntry {
  /**
   * Stable identity for scroll bookkeeping (indices shift on truncation).
   */
  id: number
  route: Route
}

class NavigationServiceImpl implements NavigationService {
  #stack: HistoryEntry[] = []
  #index = 0
  #arrivalSeq = 0
  #arrivalFocusEditor = false
  #nextId = 0
  #revision = 0
  /**
   * Scroll offsets by entry id.
   */
  readonly #scrollById = new Map<number, number>()
  /**
   * Last offset per long-lived surface, independent of history entries.
   */
  readonly #scrollBySurface = new Map<string, number>()
  readonly #listeners = new Set<() => void>()
  #state: NavigationState

  constructor(deps?: NavigationServiceDeps) {
    this.#state = this.#start(deps?.initialRoute ?? { kind: 'today' })
  }

  getState(): NavigationState {
    return this.#state
  }

  subscribe(listener: () => void): Unlisten {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  navigate(route: Route, options?: NavigateOptions): void {
    this.#revision += 1
    const target = normalizeRoute(route)
    const surface = scrollSurfaceForRoute(target)
    const currentEntry = this.#stack[this.#index]!
    // A surface restore only means something when coming from OFF the surface;
    // the Daily tab clicked while already on the stream is an explicit
    // re-anchor request, exactly like ⌘D.
    const returning =
      options?.restoreSurfaceScroll === true &&
      surface !== null &&
      scrollSurfaceForRoute(currentEntry.route) !== surface
    const restored = returning ? this.#scrollBySurface.get(surface) : undefined
    if (surface !== null && restored === undefined) {
      // An explicit arrival re-anchors the surface, making its saved offset
      // stale — drop it so a later nav-tab return re-anchors too instead of
      // resurrecting the pre-arrival position. Scrolling after the arrival
      // repopulates it.
      this.#scrollBySurface.delete(surface)
    }
    if (routesEqual(currentEntry.route, target)) {
      if (restored !== undefined) {
        this.#scrollById.set(currentEntry.id, restored)
      } else {
        // No stack growth — but this is still an explicit arrival: forget the
        // entry's saved offset so the view re-anchors to its target instead of
        // restoring the old scroll position.
        this.#scrollById.delete(currentEntry.id)
      }
    } else {
      const dropped = this.#stack.slice(this.#index + 1)
      for (const entry of dropped) {
        this.#scrollById.delete(entry.id) // truncated branch — free its offsets
      }
      const id = this.#nextId++
      if (restored !== undefined) {
        this.#scrollById.set(id, restored) // seed the fresh entry with the surface offset
      }
      this.#stack = [...this.#stack.slice(0, this.#index + 1), { id, route: target }]
      this.#index = this.#stack.length - 1
    }
    this.#arrivalSeq += 1
    this.#arrivalFocusEditor = options?.focusEditor === true
    this.#publish()
  }

  back(): void {
    if (this.#index === 0) {
      return // nothing behind us — must not advance the navigation revision
    }
    this.#revision += 1
    this.#arrivalFocusEditor = false // history moves are never focus arrivals
    this.#index -= 1
    this.#publish()
  }

  forward(): void {
    if (this.#index >= this.#stack.length - 1) {
      return
    }
    this.#revision += 1
    this.#arrivalFocusEditor = false
    this.#index += 1
    this.#publish()
  }

  navigationRevision(): number {
    return this.#revision
  }

  saveScrollState(offset: number, at: NavigationPosition = this.#state): void {
    this.#scrollById.set(at.entryId, offset)
    const surface = scrollSurfaceForRoute(at.route)
    if (surface !== null) {
      this.#scrollBySurface.set(surface, offset)
    }
  }

  clearScrollState(at: NavigationPosition = this.#state): void {
    this.#scrollById.delete(at.entryId)
    const surface = scrollSurfaceForRoute(at.route)
    if (surface !== null) {
      this.#scrollBySurface.delete(surface)
    }
  }

  savedScroll(at: NavigationPosition = this.#state): number | null {
    return this.#scrollById.get(at.entryId) ?? null
  }

  noteMoved(from: string, to: string): void {
    const current = this.#stack[this.#index]!.route
    if (current.kind === 'note' && current.path === from) {
      this.#revision += 1
    }
    let changed = false
    const moved = this.#stack.map((entry) => {
      if (entry.route.kind === 'note' && entry.route.path === from) {
        changed = true
        return { ...entry, route: { kind: 'note' as const, path: to } }
      }
      return entry
    })
    if (changed) {
      this.#stack = moved
      this.#publish()
    }
  }

  reset(initialRoute?: Route): void {
    this.#revision += 1
    this.#state = this.#start(initialRoute ?? { kind: 'today' })
  }

  #snapshot(): NavigationState {
    const entry = this.#stack[this.#index]!
    return {
      route: entry.route,
      entryId: entry.id,
      arrivalSeq: this.#arrivalSeq,
      arrivalFocusEditor: this.#arrivalFocusEditor,
      canBack: this.#index > 0,
      canForward: this.#index < this.#stack.length - 1,
      backRoute: this.#index > 0 ? this.#stack[this.#index - 1]!.route : null,
    }
  }

  #start(initialRoute: Route): NavigationState {
    this.#nextId = 0
    this.#stack = [{ id: this.#nextId++, route: normalizeRoute(initialRoute) }]
    this.#index = 0
    this.#arrivalSeq = 0
    this.#arrivalFocusEditor = false
    this.#scrollById.clear()
    this.#scrollBySurface.clear()
    return this.#snapshot()
  }

  #publish(): void {
    this.#state = this.#snapshot()
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

export function createNavigationService(deps?: NavigationServiceDeps): NavigationService {
  return new NavigationServiceImpl(deps)
}
