import { z } from 'zod'
import { browser } from 'wxt/browser'

const INCLUDE_PAGE_TEXT_KEY = 'preference:includePageText'

const popupPreferencesSchema = z.object({
  [INCLUDE_PAGE_TEXT_KEY]: z.boolean().optional(),
})

/** Read the persisted popup choice for full-page text capture. */
export async function readIncludePageTextPreference(): Promise<boolean> {
  const stored = await browser.storage.local.get(INCLUDE_PAGE_TEXT_KEY)
  const parsed = popupPreferencesSchema.safeParse(stored)
  return parsed.success ? parsed.data[INCLUDE_PAGE_TEXT_KEY] ?? false : false
}

/** Persist the popup choice for full-page text capture. */
export async function writeIncludePageTextPreference(includePageText: boolean): Promise<void> {
  await browser.storage.local.set({ [INCLUDE_PAGE_TEXT_KEY]: includePageText })
}
