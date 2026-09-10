import { browser } from 'wxt/browser'

/** X host grants are the bookmark capture opt-in. */
export const X_ORIGINS = ['https://x.com/*', 'https://twitter.com/*']

/** Both origins are required so partial grants never silently enable capture. */
export function hasXPermission(): Promise<boolean> {
  return browser.permissions.contains({ origins: X_ORIGINS })
}

/** Change the host grant directly from a user gesture. */
export async function setXPermission(enabled: boolean): Promise<boolean> {
  if (enabled) await browser.permissions.request({ origins: X_ORIGINS })
  else await browser.permissions.remove({ origins: X_ORIGINS })
  return await hasXPermission()
}
