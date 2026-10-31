import { DEEP_LINK_SCHEME, dailyDeepLink, noteDeepLink } from '@reflect/core'
import type { Route } from './route.ts'

/**
 * The write side of the deep-link codec: every URL this module emits parses
 * back to the same meaning through `deep-link-parse.ts` (pinned by the round-trip
 * tests). "Copy deep link" builds its clipboard text here.
 */

/**
 * The deep link addressing a route, or null for screens the grammar
 * deliberately doesn't name (all-notes, chat, settings — in-app surfaces, not
 * addresses). Note routes are path-shaped here; "Copy deep link" prefers the
 * id form via {@link noteDeepLink} so the link survives renames.
 */
export function deepLinkForRoute(route: Route): string | null {
  switch (route.kind) {
    case 'today':
      return `${DEEP_LINK_SCHEME}://today`
    case 'tasks':
      return `${DEEP_LINK_SCHEME}://tasks`
    case 'daily':
      return dailyDeepLink(route.date)
    case 'search':
      return `${DEEP_LINK_SCHEME}://search?q=${encodeURIComponent(route.query)}`
    case 'note':
      return noteDeepLink(route.path)
    case 'allNotes':
    case 'chat':
    case 'settings':
    case 'graphs':
    case 'licenses':
      return null
  }
}
