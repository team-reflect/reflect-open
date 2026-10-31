import { DEEP_LINK_SCHEME } from './deep-link.ts'

/**
 * `reflect://note/<target>` — `target` is a frontmatter id, title, or alias.
 */
export function noteDeepLink(target: string): string {
  return `${DEEP_LINK_SCHEME}://note/${encodeURIComponent(target)}`
}

/**
 * `reflect://daily/<date>` for an ISO `YYYY-MM-DD` date.
 */
export function dailyDeepLink(date: string): string {
  return `${DEEP_LINK_SCHEME}://daily/${date}`
}
