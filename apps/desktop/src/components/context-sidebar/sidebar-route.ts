import type { Route } from '@/routing/route'

/** What the AppShell's right context region should describe for a route. */
export type ContextSidebarTarget =
  | { kind: 'daily'; date: string }
  | { kind: 'note'; path: string }

/**
 * The subject of the context sidebar for `route`, or `null` when the route
 * gets none: the `today` route follows the live clock, a `daily/:date` route
 * uses its date (real by the router's `normalizeRoute` invariant), a `note`
 * route uses its path, and `search`/`settings` routes show no note context.
 */
export function contextSidebarTarget(route: Route, today: string): ContextSidebarTarget | null {
  switch (route.kind) {
    case 'today':
      return { kind: 'daily', date: today }
    case 'daily':
      return { kind: 'daily', date: route.date }
    case 'note':
      return { kind: 'note', path: route.path }
    case 'search':
    case 'settings':
      return null
  }
}
