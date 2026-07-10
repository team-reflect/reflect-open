/**
 * Typed product routes (Plan 06). These are app states, not page names — the
 * integration point for navigation, back/forward history, and later deep links
 * and CLI `open` (Plan 14).
 *
 * Note identity is the graph-relative path in the first wave (Plan 03), so the
 * note route carries `path` — the reserved frontmatter `id` can join it later
 * without breaking the shape.
 */
import { dailyPath, dateFromDailyPath, isDaily } from '@reflect/core'
import { isIsoDate } from '@/lib/dates'

export type Route =
  | { kind: 'today' }
  | { kind: 'daily'; date: string }
  | { kind: 'note'; path: string }
  | { kind: 'allNotes'; tag: string | null }
  | { kind: 'search'; query: string }
  | { kind: 'tasks' }
  | { kind: 'chat' }
  | { kind: 'settings' }
  // The graph-switcher screen — a mobile settings sub-screen; desktop renders
  // it as the settings screen (its switcher lives in the sidebar footer).
  | { kind: 'graphs' }

/** A route that addresses one concrete note, including a dated daily note. */
export type NoteRoute = Extract<Route, { kind: 'daily' | 'note' }>

/** Structural route equality (used to avoid pushing no-op history entries). */
export function routesEqual(a: Route, b: Route): boolean {
  if (a.kind !== b.kind) {
    return false
  }
  switch (a.kind) {
    case 'today':
    case 'tasks':
    case 'chat':
    case 'settings':
    case 'graphs':
      return true
    case 'daily':
      return a.date === (b as Extract<Route, { kind: 'daily' }>).date
    case 'note':
      return a.path === (b as Extract<Route, { kind: 'note' }>).path
    case 'allNotes':
      return a.tag === (b as Extract<Route, { kind: 'allNotes' }>).tag
    case 'search':
      return a.query === (b as Extract<Route, { kind: 'search' }>).query
  }
}

/**
 * The route a resolved note path navigates to: a real-calendar daily date opens
 * the daily view; anything else — including a `daily/…` file whose name is a
 * well-formed but impossible date (e.g. `2026-02-31`), which `dailyPath` would
 * reject — opens as a plain note so navigation can never crash the workspace.
 */
export function routeForPath(path: string): NoteRoute {
  const date = isDaily(path) ? dateFromDailyPath(path) : null
  return date !== null && isIsoDate(date) ? { kind: 'daily', date } : { kind: 'note', path }
}

/**
 * The daily date a route is anchored on: today's date for the `today` route
 * (hence the `today` parameter), the route's own date for `daily/:date`, and
 * null for any route that isn't a daily view (notes, search, chat, settings).
 */
function dailyDateForRoute(route: Route, today: string): string | null {
  switch (route.kind) {
    case 'today':
      return today
    case 'daily':
      return route.date
    default:
      return null
  }
}

/**
 * The daily date the user is *effectively* working on: the day focused in the
 * daily stream when there is one, otherwise the route's own daily date. Null
 * when the route isn't a daily view, where the focused day is irrelevant.
 *
 * The stream keeps a single `daily/:date` route as focus moves between days, so
 * the focused day — not the routed one — is what both the context sidebar and
 * note-scoped commands must point at. This is the one place that precedence
 * lives, so those two surfaces can never disagree about which day they target.
 */
export function effectiveDailyDate(
  route: Route,
  today: string,
  focusedDailyDate: string | null,
): string | null {
  const routed = dailyDateForRoute(route, today)
  return routed === null ? null : focusedDailyDate ?? routed
}

/**
 * The note file a route is editing — what note-scoped commands (pin, …) act
 * on: a note route's path, a daily route's file (today's for the `today`
 * route), and null for screens that edit no note (search, chat, settings).
 */
export function notePathForRoute(route: Route, today: string): string | null {
  if (route.kind === 'note') {
    return route.path
  }
  const daily = dailyDateForRoute(route, today)
  return daily === null ? null : dailyPath(daily)
}

/**
 * The invariant the router maintains on every entry: a `daily` route never
 * carries an impossible calendar date past the boundary (`dailyPath` would
 * throw on one downstream). A malformed date collapses to the `today` route —
 * the same anchoring the stream would choose — so views consuming
 * {@link useRouter} can trust `route.date` without re-validating it.
 */
export function normalizeRoute(route: Route): Route {
  return route.kind === 'daily' && !isIsoDate(route.date) ? { kind: 'today' } : route
}
