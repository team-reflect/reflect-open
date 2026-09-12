import { browser } from 'wxt/browser'
import { z } from 'zod'

const BOOKMARK_SETTINGS_KEY = 'bookmarkSettings'
const bookmarkSettingsSchema = z.object({ enabled: z.boolean() })
export type BookmarkSettings = z.infer<typeof bookmarkSettingsSchema>

/** Capture is on by default; the popup checkbox opts out. */
export async function readBookmarkSettings(): Promise<BookmarkSettings> {
  const stored = await browser.storage.local.get(BOOKMARK_SETTINGS_KEY)
  const result = bookmarkSettingsSchema.safeParse(stored[BOOKMARK_SETTINGS_KEY])
  return result.success ? result.data : { enabled: true }
}

export async function writeBookmarkSettings(settings: BookmarkSettings): Promise<void> {
  await browser.storage.local.set({ [BOOKMARK_SETTINGS_KEY]: settings })
}
