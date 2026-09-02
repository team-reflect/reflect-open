import { browser } from 'wxt/browser'
import { X_ORIGINS } from './origins'
import { readXCapturePreferences, writeXCapturePreferences } from './preferences'

export { X_ORIGINS } from './origins'

/**
 * The opt-in host permission and the runtime-registered content script for
 * X (Plan 25). Nothing here is granted at install: the origins are
 * `optional_host_permissions`, requested from a user gesture when the
 * feature is switched on, and the content script is registered only then.
 * Registrations do not survive an extension update, so the background
 * re-syncs on install; a permission revoked in `chrome://extensions` turns
 * the feature off.
 */

export const X_CONTENT_SCRIPT_ID = 'x-bookmarks'

/** WXT's output path for `entrypoints/x-bookmarks.content.ts`. */
const X_CONTENT_SCRIPT_FILE = '/content-scripts/x-bookmarks.js'

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

async function isRegistered(): Promise<boolean> {
  const scripts = await browser.scripting.getRegisteredContentScripts({
    ids: [X_CONTENT_SCRIPT_ID],
  })
  return scripts.length > 0
}

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
  const wanted = preferences.bookmarks && granted
  const registered = await isRegistered()
  if (wanted && !registered) {
    await browser.scripting.registerContentScripts([
      {
        id: X_CONTENT_SCRIPT_ID,
        js: [X_CONTENT_SCRIPT_FILE],
        matches: [...X_ORIGINS],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ])
  } else if (!wanted && registered) {
    await browser.scripting.unregisterContentScripts({ ids: [X_CONTENT_SCRIPT_ID] })
  }
}

/**
 * Start watching in X tabs that are already open, so switching the feature
 * on does not need a reload. The script is idempotent, so a tab that already
 * runs it just restarts the watcher.
 */
export async function injectIntoOpenXTabs(): Promise<void> {
  const tabs = await browser.tabs.query({ url: [...X_ORIGINS] })
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) {
        return
      }
      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: [X_CONTENT_SCRIPT_FILE],
        })
      } catch (cause) {
        console.warn('could not start X capture in an open tab:', cause)
      }
    }),
  )
}

/**
 * The switch-on flow behind the options page and the popup nudge: ask for
 * the origins, and only on a grant persist the preference, register, and
 * start in open tabs. Returns whether the feature is on afterwards.
 */
export async function enableXCapture(): Promise<boolean> {
  if (!(await requestXPermission())) {
    return false
  }
  await writeXCapturePreferences({ bookmarks: true })
  await syncXContentScript()
  await injectIntoOpenXTabs()
  return true
}

/** The switch-off flow: preference off, script unregistered. The origins stay granted. */
export async function disableXCapture(): Promise<void> {
  await writeXCapturePreferences({ bookmarks: false, likes: false })
  await syncXContentScript()
}
