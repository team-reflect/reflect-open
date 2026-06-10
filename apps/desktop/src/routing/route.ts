/**
 * Typed product routes (Plan 06). These are app states, not page names — the
 * integration point for navigation, back/forward history, and later deep links
 * and CLI `open` (Plan 14).
 *
 * Note identity is the graph-relative path in the first wave (Plan 03), so the
 * note route carries `path` — the reserved frontmatter `id` can join it later
 * without breaking the shape.
 */
import { dateFromDailyPath, isDaily } from '@reflect/core'
import { isIsoDate } from '@/lib/dates'

export type Route =
  | { kind: 'today' }
  | { kind: 'daily'; date: string }
  | { kind: 'note'; path: string }
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
