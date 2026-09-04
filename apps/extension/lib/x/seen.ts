import { z } from 'zod'
import { browser } from 'wxt/browser'

/**
 * Posts this browser already captured (Plan 25), one storage key per post
 * (`seen:x:<id>` → the capture time) — written the moment a capture is
 * enqueued, so a service worker torn down a second later loses nothing (V1
 * kept this in a debounced snapshot and did). Un-bookmarking clears the key,
 * so a deliberate re-bookmark captures again; scrolling past a post already
 * bookmarked never reaches here (the watcher only reports transitions).
 */

export const SEEN_KEY_PREFIX = 'seen:x:'

/** Keep the set bounded; past this the oldest entries go. */
export const SEEN_CAP = 5000

/** The storage key remembering one post. */
export function seenKey(id: string): string {
  return `${SEEN_KEY_PREFIX}${id}`
}

export async function isPostSeen(id: string): Promise<boolean> {
  const stored = await browser.storage.local.get(seenKey(id))
  return seenKey(id) in stored
}

export async function clearPostSeen(id: string): Promise<void> {
  await browser.storage.local.remove(seenKey(id))
}

/** Remember a post, pruning the oldest entries past {@link SEEN_CAP}. */
export async function markPostSeen(id: string, now: () => number = Date.now): Promise<void> {
  await browser.storage.local.set({ [seenKey(id)]: now() })
  const stored = await browser.storage.local.get(null)
  const entries: Array<{ key: string; seenAt: number }> = []
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(SEEN_KEY_PREFIX)) {
      continue
    }
    const seenAt = z.number().safeParse(value)
    entries.push({ key, seenAt: seenAt.success ? seenAt.data : 0 })
  }
  if (entries.length <= SEEN_CAP) {
    return
  }
  entries.sort(
    (first, second) => first.seenAt - second.seenAt || first.key.localeCompare(second.key),
  )
  await browser.storage.local.remove(
    entries.slice(0, entries.length - SEEN_CAP).map((entry) => entry.key),
  )
}
