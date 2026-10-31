import { browser } from 'wxt/browser'
import { z } from 'zod'

export const BOOKMARK_SETTINGS_KEY = 'bookmarkSettings'
const bookmarkSettingsSchema = z.object({ enabled: z.boolean() })
export type BookmarkSettings = z.infer<typeof bookmarkSettingsSchema>

/** The host the bookmark observer needs; Chrome lets the user withhold it under Site access. */
export const X_BOOKMARK_ACCESS = { origins: ['https://x.com/*'] }

/** Capture is on by default; the options page opts out. */
export async function readBookmarkSettings(): Promise<BookmarkSettings> {
  const stored = await browser.storage.local.get(BOOKMARK_SETTINGS_KEY)
  const result = bookmarkSettingsSchema.safeParse(stored[BOOKMARK_SETTINGS_KEY])
  return result.success ? result.data : { enabled: true }
}

export async function writeBookmarkSettings(settings: BookmarkSettings): Promise<void> {
  await browser.storage.local.set({ [BOOKMARK_SETTINGS_KEY]: settings })
}
