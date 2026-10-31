import { isDaily, isNotePath, parseDeepLink, type DeepLinkTarget } from '@reflect/core'
import { routeForPath, type Route } from './route.ts'

/**
 * Derive a route from a `reflect://` link synchronously, or null when only
 * the index can answer. ⌘-click builds links with `deepLinkForRoute`, so its
 * note targets are path-shaped and resolve right here; id/title-shaped
 * targets (hand-written links) fall back to the intake's async resolution —
 * those windows briefly show today, the price of an index round-trip.
 */
export function initialRouteForDeepLink(link: string | null): Route | null {
  if (link === null) {
    return null
  }
  const parsed = parseDeepLink(link)
  if (parsed === null) {
    return null
  }
  if (parsed.kind === 'navigate') {
    return parsed.place
  }
  if (parsed.kind === 'openNote' && (isNotePath(parsed.target) || isDaily(parsed.target))) {
    return routeForPath(parsed.target)
  }
  return null
}

/**
 * The route a resolved deep link navigates to, or null when it names none.
 */
export function routeForDeepLinkTarget(target: DeepLinkTarget): Route | null {
  switch (target.kind) {
    case 'today':
    case 'tasks':
    case 'daily':
    case 'search':
      return target
    case 'note':
      return routeForPath(target.path)
    case 'capture':
    case 'none':
      return null
  }
}
