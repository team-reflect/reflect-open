import { browser } from 'wxt/browser'

const BADGE_MS = 3000
const BADGE_COLOR = '#16a34a'

let clearTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Flash a ✓ on the toolbar icon for a few seconds — the only feedback an
 * automatic capture gives. A capture nobody can see is indistinguishable
 * from one that never happened (V1's tweet saves were silent).
 */
export async function flashBadge(): Promise<void> {
  await browser.action.setBadgeBackgroundColor({ color: BADGE_COLOR })
  await browser.action.setBadgeText({ text: '✓' })
  if (clearTimer !== null) {
    clearTimeout(clearTimer)
  }
  clearTimer = setTimeout(() => {
    clearTimer = null
    void browser.action.setBadgeText({ text: '' })
  }, BADGE_MS)
}
