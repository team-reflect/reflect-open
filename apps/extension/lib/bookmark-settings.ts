import { browser } from 'wxt/browser'
import { z } from 'zod'
import { bookmarkCapabilitySchema, type BookmarkCapability } from '@reflect/core/capture-envelope'
import { HOST_NAME } from './native'

export const BOOKMARK_SETTINGS_KEY = 'bookmarkSettings'
export const bookmarkSettingsSchema = z.object({
  enabled: z.boolean(),
  presentation: z.enum(['link', 'embed']),
  targetGraphId: bookmarkCapabilitySchema.shape.targetGraphId.optional(),
})
export type BookmarkSettings = z.infer<typeof bookmarkSettingsSchema>

export async function readBookmarkSettings(): Promise<BookmarkSettings> {
  const stored = await browser.storage.local.get(BOOKMARK_SETTINGS_KEY)
  const result = bookmarkSettingsSchema.safeParse(stored[BOOKMARK_SETTINGS_KEY])
  return result.success ? result.data : { enabled: false, presentation: 'link' }
}

/** Pairing requires a bookmark-aware desktop to have opened a graph. */
export async function getBookmarkCapability(): Promise<BookmarkCapability> {
  const response: unknown = await browser.runtime.sendNativeMessage(HOST_NAME, {
    type: 'bookmark-capabilities',
  })
  const parsed = bookmarkCapabilitySchema.safeParse(response)
  if (!parsed.success)
    throw new Error('Update Reflect and open your target graph, then pair again.')
  return parsed.data
}
