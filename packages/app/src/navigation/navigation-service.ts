import type { Store, Unlisten } from '@reflect/core'
import type { DayScrollPosition } from '../daily/day-window.ts'
import {
  normalizeRoute,
  rootSectionForRoute,
  routesEqual,
  type Route,
  type Section,
} from './route.ts'

/**
 * The app's navigation history (Plan 06): a stack over typed {@link Route}s —
 * no URL, no dependency. `navigate` pushes (truncating any forward entries,
 * like a browser), `back`/`forward` move the cursor.
 *
 * Each history entry can carry a **scroll position** (Plan 06b): views report
 * theirs via `saveScrollState` (never notifies subscribers — safe from scroll
 * handlers) and read `savedScroll()` after a back/forward restores an entry.
 * Plain views save a pixel offset; the daily stream saves a {@link DayScrollPosition}.
 *
 * Long-lived surfaces (the daily stream, shared by the today/daily routes)
 * additionally keep a **surface position** — the last reported position,
 * independent of any history entry — so a Daily section return can resume the stream
 * where the user left it (`selectSection('daily')`) even though it lands on
 * a fresh entry.
 */

/**
 * A view's saved scroll position: a pixel offset, or a daily-stream day.
 */
export type ScrollPosition = number | DayScrollPosition

export interface NavigateOptions {
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
  /**
   * The section of a new history entry. Defaults to the section whose root
   * screen the route shows (for Chat, the one {@link NavigationService.setChatSection} set),
   * else the current entry's section.
   */
  section?: Section | undefined
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
  /**
   * The section of the current history entry, fixed when the entry was pushed.
   */
  readonly section: Section
}

/**
 * The history entry a view is showing. A view that renders behind the service
 * (a pending transition) passes the state it rendered, so its scroll
 * bookkeeping lands on the entry on screen rather than the one arriving.
 */
export type NavigationPosition = Pick<NavigationState, 'entryId' | 'route'>

/**
 * Scroll bookkeeping and `reset` do not notify subscribers.
 */
export interface NavigationService extends Store<NavigationState> {
  navigate(route: Route, options?: NavigateOptions): void
  /**
   * Go to `section`. Daily lands on its last day with the stream's scroll
   * restored. Another section lands on its last screen, pushed over its last
   * root so Back reveals the root; from within the section it lands on the
   * section's default root (All without a tag filter).
   */
  selectSection(section: Section, options?: NavigateOptions): void
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
   * Record a view's scroll position on its history entry (the current one by default).
   */
  saveScrollState(position: ScrollPosition, at?: NavigationPosition): void
  /**
   * Discard a view's saved scroll positions — its history entry's and, when the
   * route belongs to a long-lived surface, the surface's too — so the view
   * re-anchors when revisited through **any** door (⌘[ back or a
   * Daily section return alike).
   */
  clearScrollState(at?: NavigationPosition): void
  /**
   * The entry's recorded position (present when revisited), or `null`.
   */
  savedScroll(at?: NavigationPosition): ScrollPosition | null
  /**
   * A note file moved (Plan 17): rewrite every history entry that points at
   * the old path — the current route follows the file without an arrival
   * (same entry ids, so scroll positions and back/forward stay intact), and a
   * back-nav can never land on a path that no longer exists.
   */
  noteMoved(from: string, to: string): void
  /**
   * Forget the screens remembered for {@link selectSection} that show a note
   * `isGone` reports, so a section never returns to a deleted note.
   */
  forgetNotes(isGone: (path: string) => boolean): void
  /**
   * Start a fresh history on `initialRoute` (today by default) in
   * `initialSection` (by default the section whose root it shows, else
   * Daily), dropping every entry and scroll position: switching graphs must
   * not carry the old graph's history. The view tree that mounts for the new history calls this while it
   * renders, so subscribers are not notified; read `get()` afterwards.
   */
  reset(initialRoute?: Route, initialSection?: Section): void
  /**
   * Set the section a Chat route joins when a navigation names none: Chat by
   * default, All where Chat is a card over All.
   */
  setChatSection(section: Section): void
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
  section: Section
}

/**
 * The root screen of `section` before it has shown one.
 */
function defaultSectionRoot(section: Section): Route {
  switch (section) {
    case 'daily':
      return { kind: 'today' }
    case 'all':
      return { kind: 'allNotes', tag: null }
    case 'tasks':
      return { kind: 'tasks' }
    case 'chat':
      return { kind: 'chat' }
  }
}

function movedRoute(route: Route, from: string, to: string): Route {
  return route.kind === 'note' && route.path === from ? { kind: 'note', path: to } : route
}

class NavigationServiceImpl implements NavigationService {
  #stack: HistoryEntry[] = []
  #chatSection: Section = 'chat'
  #index = 0
  #arrivalSeq = 0
  #arrivalFocusEditor = false
  #nextId = 0
  #revision = 0
  /**
   * Scroll positions by entry id.
   */
  readonly #scrollById = new Map<number, ScrollPosition>()
  /**
   * Last position per long-lived surface, independent of history entries.
   */
  readonly #scrollBySurface = new Map<string, ScrollPosition>()
  /**
   * The screen each section showed last.
   */
  readonly #lastBySection = new Map<Section, Route>()
  /**
   * The root screen each section showed last.
   */
  readonly #rootBySection = new Map<Section, Route>()
  // Not a `WritableStore`: `reset` replaces the state without notifying,
  // because it runs while a view tree renders.
  readonly #listeners = new Set<() => void>()
  #state: NavigationState

  constructor(deps?: NavigationServiceDeps) {
    this.#state = this.#start(deps?.initialRoute ?? { kind: 'today' })
  }

  readonly get = (): NavigationState => {
    return this.#state
  }

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  navigate(route: Route, options?: NavigateOptions): void {
    this.#arrive(route, options, false)
    this.#publish()
  }

  selectSection(section: Section, options?: NavigateOptions): void {
    const current = this.#stack[this.#index]!
    const root = this.#rootBySection.get(section) ?? defaultSectionRoot(section)
    if (section === 'daily') {
      // The stream resumes where it was left.
      this.#arrive(root, { ...options, section }, true)
      this.#publish()
      return
    }
    if (current.section === section) {
      this.navigate(defaultSectionRoot(section), { ...options, section })
      return
    }
    const last = this.#lastBySection.get(section) ?? root
    if (!routesEqual(last, root)) {
      this.#arrive(root, { section }, false)
    }
    this.#arrive(last, { ...options, section }, false)
    this.#publish()
  }

  /**
   * @param restoreSurface Seed a new entry with its surface's last scroll
   * position when it returns to that surface from off it.
   */
  #arrive(route: Route, options: NavigateOptions | undefined, restoreSurface: boolean): void {
    this.#revision += 1
    const target = normalizeRoute(route)
    const surface = scrollSurfaceForRoute(target)
    const currentEntry = this.#stack[this.#index]!
    // A surface restore only means something when coming from OFF the surface;
    // the Daily tab clicked while already on the stream is an explicit
    // re-anchor request, exactly like ⌘D.
    const returning =
      restoreSurface && surface !== null && scrollSurfaceForRoute(currentEntry.route) !== surface
    const restored = returning ? this.#scrollBySurface.get(surface) : undefined
    if (surface !== null && restored === undefined) {
      // An explicit arrival re-anchors the surface, making its saved position
      // stale — drop it so a later Daily section return re-anchors too instead of
      // resurrecting the pre-arrival position. Scrolling after the arrival
      // repopulates it.
      this.#scrollBySurface.delete(surface)
    }
    const section = options?.section ?? this.#sectionFor(target) ?? currentEntry.section
    const sameEntry = routesEqual(currentEntry.route, target) && section === currentEntry.section
    if (sameEntry) {
      if (restored !== undefined) {
        this.#scrollById.set(currentEntry.id, restored)
      } else {
        // No stack growth — but this is still an explicit arrival: forget the
        // entry's saved position so the view re-anchors to its target instead of
        // restoring the old scroll position.
        this.#scrollById.delete(currentEntry.id)
      }
    } else {
      const dropped = this.#stack.slice(this.#index + 1)
      for (const entry of dropped) {
        this.#scrollById.delete(entry.id) // truncated branch — free its positions
      }
      const id = this.#nextId++
      if (restored !== undefined) {
        this.#scrollById.set(id, restored) // seed the fresh entry with the surface position
      }
      this.#stack = [...this.#stack.slice(0, this.#index + 1), { id, route: target, section }]
      this.#index = this.#stack.length - 1
    }
    this.#arrivalSeq += 1
    this.#arrivalFocusEditor = options?.focusEditor === true
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

  saveScrollState(position: ScrollPosition, at: NavigationPosition = this.#state): void {
    this.#scrollById.set(at.entryId, position)
    const surface = scrollSurfaceForRoute(at.route)
    if (surface !== null) {
      this.#scrollBySurface.set(surface, position)
    }
  }

  clearScrollState(at: NavigationPosition = this.#state): void {
    this.#scrollById.delete(at.entryId)
    const surface = scrollSurfaceForRoute(at.route)
    if (surface !== null) {
      this.#scrollBySurface.delete(surface)
    }
  }

  savedScroll(at: NavigationPosition = this.#state): ScrollPosition | null {
    return this.#scrollById.get(at.entryId) ?? null
  }

  noteMoved(from: string, to: string): void {
    const current = this.#stack[this.#index]!.route
    if (current.kind === 'note' && current.path === from) {
      this.#revision += 1
    }
    for (const [section, route] of this.#lastBySection) {
      this.#lastBySection.set(section, movedRoute(route, from, to))
    }
    let changed = false
    const moved = this.#stack.map((entry) => {
      const route = movedRoute(entry.route, from, to)
      if (route !== entry.route) {
        changed = true
        return { ...entry, route }
      }
      return entry
    })
    if (changed) {
      this.#stack = moved
      this.#publish()
    }
  }

  forgetNotes(isGone: (path: string) => boolean): void {
    for (const [section, route] of this.#lastBySection) {
      if (route.kind === 'note' && isGone(route.path)) {
        this.#lastBySection.delete(section)
      }
    }
  }

  reset(initialRoute?: Route, initialSection?: Section): void {
    this.#revision += 1
    this.#state = this.#start(initialRoute ?? { kind: 'today' }, initialSection)
  }

  setChatSection(section: Section): void {
    this.#chatSection = section
  }

  /**
   * The section a new entry for `route` joins, or `null` for a route that
   * opens over the current section.
   */
  #sectionFor(route: Route): Section | null {
    return route.kind === 'chat' ? this.#chatSection : rootSectionForRoute(route)
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
      section: entry.section,
    }
  }

  #start(initialRoute: Route, initialSection?: Section): NavigationState {
    this.#nextId = 0
    const route = normalizeRoute(initialRoute)
    const section = initialSection ?? this.#sectionFor(route) ?? 'daily'
    this.#stack = [{ id: this.#nextId++, route, section }]
    this.#index = 0
    this.#arrivalSeq = 0
    this.#arrivalFocusEditor = false
    this.#scrollById.clear()
    this.#scrollBySurface.clear()
    this.#lastBySection.clear()
    this.#rootBySection.clear()
    this.#remember()
    return this.#snapshot()
  }

  /**
   * Record the current entry as the screen its section showed last.
   */
  #remember(): void {
    const { route, section } = this.#stack[this.#index]!
    this.#lastBySection.set(section, route)
    if (rootSectionForRoute(route) === section) {
      this.#rootBySection.set(section, route)
    }
  }

  #publish(): void {
    this.#remember()
    this.#state = this.#snapshot()
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

export function createNavigationService(deps?: NavigationServiceDeps): NavigationService {
  return new NavigationServiceImpl(deps)
}
