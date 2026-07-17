import type { Route } from '@/routing/route'
import { DEEP_LINK_SCHEME } from '@/lib/deep-links/deep-link'

/**
 * The write side of the deep-link codec: every URL this module emits parses
 * back to the same meaning through `parse.ts` (pinned by the round-trip
 * tests). "Copy deep link" builds its clipboard text here.
 */

/** `reflect://note/<target>` — `target` is a frontmatter id, title, or alias. */
export function noteDeepLink(target: string): string {
  return `${DEEP_LINK_SCHEME}://note/${encodeURIComponent(target)}`
}

/** `reflect://journal/<date>` for an ISO `YYYY-MM-DD` date. */
export function dailyDeepLink(date: string): string {
  return `${DEEP_LINK_SCHEME}://journal/${date}`
}

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
      return null
  }
}
