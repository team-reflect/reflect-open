import { injectIntoOpenXTabs, setXContentScriptRegistered, stopInOpenXTabs } from './content-script'
import { hasXPermission, requestXPermission } from './permission'
import { readXCapturePreferences, writeXCapturePreferences } from './preferences'

/**
 * The switch-on / switch-off flows for X bookmark capture (Plan 25), and the
 * sync that keeps the content-script registration honest with the stored
 * preference and the granted permission.
 */

/**
 * Make the registration match the preference: registered while the feature
 * is on and the origins are granted, unregistered otherwise. A preference
 * left on after the permission was revoked is switched off here, so the
 * options page never claims a feature that cannot run.
 */
export async function syncXContentScript(): Promise<void> {
  const preferences = await readXCapturePreferences()
  const granted = await hasXPermission()
  if (preferences.bookmarks && !granted) {
    await writeXCapturePreferences({ bookmarks: false, likes: false })
  }
  await setXContentScriptRegistered(preferences.bookmarks && granted)
}

/**
 * The switch-on flow behind the options page and the popup nudge: ask for
 * the origins, and only on a grant register the script, persist the
 * preference, and start in open tabs — in that order, so a registration
 * failure never leaves the switch reading "on" with nothing running.
 * Returns whether the feature is on afterwards.
 */
export async function enableXCapture(): Promise<boolean> {
  if (!(await requestXPermission())) {
    return false
  }
  await setXContentScriptRegistered(true)
  await writeXCapturePreferences({ bookmarks: true })
  await injectIntoOpenXTabs()
  return true
}

/**
 * The switch-off flow: preference off, script unregistered, and the watchers
 * already running in open tabs told to stop. The origins stay granted.
 */
export async function disableXCapture(): Promise<void> {
  await writeXCapturePreferences({ bookmarks: false, likes: false })
  await setXContentScriptRegistered(false)
  await stopInOpenXTabs()
}
