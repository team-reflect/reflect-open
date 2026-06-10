import type { Route } from '@/routing/route'

/** Which contextual sidebar a route mounts in the AppShell's right region. */
export type ContextSidebarTarget =
  | { kind: 'daily'; date: string }
  | { kind: 'note'; path: string }

/**
 * The context sidebar for `route`, or `null` when the route gets none: the
 * `today` route follows the live clock, a `daily/:date` route uses its date
 * (real by the router's `normalizeRoute` invariant), a `note` route gets the
 * note's own context (backlinks + similar notes), and `search`/`settings`
 * show no contextual panel.
 */
export function contextSidebarFor(route: Route, today: string): ContextSidebarTarget | null {
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
