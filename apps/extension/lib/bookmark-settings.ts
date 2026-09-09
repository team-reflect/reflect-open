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

let settingsWrite = Promise.resolve()

export async function readBookmarkSettings(): Promise<BookmarkSettings> {
  await settingsWrite
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

let generation = 0

/** Invalidate work already awaiting permissions, tab lookup, or queue admission. */
export function invalidateBookmarkCapture(): void {
  generation += 1
}

export function bookmarkCaptureGeneration(): number {
  return generation
}

/** Called only by the background, including permission revocation. */
export function writeBookmarkSettings(settings: BookmarkSettings): Promise<void> {
  invalidateBookmarkCapture()
  const next = settingsWrite
    .then(async () => {
      await browser.storage.local.set({ [BOOKMARK_SETTINGS_KEY]: settings })
      if (!settings.enabled)
        await browser.permissions.remove({
          permissions: ['webRequest'],
          origins: ['https://x.com/*'],
        })
    })
    .finally(invalidateBookmarkCapture)
  settingsWrite = next.catch(() => {})
  return next
}
