import { z } from 'zod'
import { browser } from 'wxt/browser'

/**
 * The X capture switches (Plan 25), in `chrome.storage.local` beside the
 * popup preference. `bookmarks` is the feature: on means the content script
 * is registered on x.com and every bookmark captures. `likes` widens the
 * trigger to likes and means nothing while `bookmarks` is off.
 */

export const X_BOOKMARKS_KEY = 'preference:xBookmarks'
export const X_LIKES_KEY = 'preference:xLikes'

export interface XCapturePreferences {
  bookmarks: boolean
  likes: boolean
}

const storedSchema = z.object({
  [X_BOOKMARKS_KEY]: z.boolean().optional(),
  [X_LIKES_KEY]: z.boolean().optional(),
})

/** Read both switches; anything unset or corrupt reads as off. */
export async function readXCapturePreferences(): Promise<XCapturePreferences> {
  const stored = await browser.storage.local.get([X_BOOKMARKS_KEY, X_LIKES_KEY])
  const parsed = storedSchema.safeParse(stored)
  if (!parsed.success) {
    return { bookmarks: false, likes: false }
  }
  return {
    bookmarks: parsed.data[X_BOOKMARKS_KEY] ?? false,
    likes: parsed.data[X_LIKES_KEY] ?? false,
  }
}

/** Persist one or both switches. */
export async function writeXCapturePreferences(patch: Partial<XCapturePreferences>): Promise<void> {
  const items: Record<string, boolean> = {}
  if (patch.bookmarks !== undefined) {
    items[X_BOOKMARKS_KEY] = patch.bookmarks
  }
  if (patch.likes !== undefined) {
    items[X_LIKES_KEY] = patch.likes
  }
  if (Object.keys(items).length > 0) {
    await browser.storage.local.set(items)
  }
}
