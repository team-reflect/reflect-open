import { isIsoDate } from '@/lib/dates'
import type { Route } from '@/routing/route'

/**
 * The day the daily context sidebar describes for `route`, or `null` when the
 * route gets no daily sidebar. Mirrors `RouteContent`'s anchoring exactly: the
 * `today` route follows the live clock, a malformed `daily/:date` anchors to
 * today (the stream does the same instead of crashing), and `note`, `search`,
 * and `settings` routes show no daily-only context.
 */
export function dailySidebarDate(route: Route, today: string): string | null {
  switch (route.kind) {
    case 'today':
      return today
    case 'daily':
      return isIsoDate(route.date) ? route.date : today
    case 'note':
    case 'search':
    case 'settings':
      return null
  }
}
