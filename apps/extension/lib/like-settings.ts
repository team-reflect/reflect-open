import { browser } from 'wxt/browser'
import { z } from 'zod'

export const LIKE_SETTINGS_KEY = 'xLikeSettings'
const likeSettingsSchema = z.object({ enabled: z.boolean() })
export type LikeSettings = z.infer<typeof likeSettingsSchema>

/** New like capture is off unless explicitly enabled. */
export async function readLikeSettings(): Promise<LikeSettings> {
  const stored = await browser.storage.local.get(LIKE_SETTINGS_KEY)
  const parsed = likeSettingsSchema.safeParse(stored[LIKE_SETTINGS_KEY])
  return parsed.success ? parsed.data : { enabled: false }
}

export async function writeLikeSettings(settings: LikeSettings): Promise<void> {
  await browser.storage.local.set({ [LIKE_SETTINGS_KEY]: settings })
}
