let latestLinkNavigationIntent = 0

/** Start a note-link activation and return its app-wide intent token. */
export function beginLinkNavigationIntent(): number {
  latestLinkNavigationIntent += 1
  return latestLinkNavigationIntent
}

/** Whether no newer note-link activation has superseded `intent`. */
export function isCurrentLinkNavigationIntent(intent: number): boolean {
  return latestLinkNavigationIntent === intent
}
