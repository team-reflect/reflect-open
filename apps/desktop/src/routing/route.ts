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
  | { kind: 'settings' }

/** Structural route equality (used to avoid pushing no-op history entries). */
export function routesEqual(a: Route, b: Route): boolean {
  if (a.kind !== b.kind) {
    return false
  }
  switch (a.kind) {
    case 'today':
    case 'settings':
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
export function routeForPath(path: string): Route {
  const date = isDaily(path) ? dateFromDailyPath(path) : null
  return date !== null && isIsoDate(date) ? { kind: 'daily', date } : { kind: 'note', path }
}

/**
 * The note file a route is editing — what note-scoped commands (pin, …) act
 * on: a note route's path, a daily route's file (today's for the `today`
 * route, hence the `today` parameter), and null for screens that edit no
 * note (search, settings).
 */
export function notePathForRoute(route: Route, today: string): string | null {
  switch (route.kind) {
    case 'note':
      return route.path
    case 'daily':
      return dailyPath(route.date)
    case 'today':
      return dailyPath(today)
    case 'allNotes':
    case 'search':
    case 'settings':
      return null
  }
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
