import { browser } from 'wxt/browser'
import { X_ORIGINS } from './origins'

/**
 * The opt-in host permission for X (Plan 25). The origins are
 * `optional_host_permissions`: never granted at install, requested from a
 * user gesture when the feature is switched on.
 */

/** Are the X origins granted right now? */
export async function hasXPermission(): Promise<boolean> {
  return await browser.permissions.contains({ origins: [...X_ORIGINS] })
}

/**
 * Ask for the X origins. Must run from a user gesture (an options-page or
 * popup click); Chrome shows its own prompt and answers whether it was
 * granted.
 */
export async function requestXPermission(): Promise<boolean> {
  return await browser.permissions.request({ origins: [...X_ORIGINS] })
}

/** Does a `permissions.onRemoved` event cover the X origins? */
export function removesXPermission(removed: { origins?: string[] | undefined }): boolean {
  const origins: readonly string[] = removed.origins ?? []
  return origins.some((origin) => (X_ORIGINS as readonly string[]).includes(origin))
}
