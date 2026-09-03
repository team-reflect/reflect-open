import { browser } from 'wxt/browser'
import { X_CAPTURE_STOP_MESSAGE_TYPE, type StopXCaptureMessage } from './message-types'
import { X_ORIGINS } from './origins'

/**
 * The runtime-registered X watcher script (Plan 25). Never declared in the
 * manifest: registered here once the feature is on and the origins are
 * granted, unregistered otherwise. Registrations do not survive an
 * extension update, so the background re-syncs on install.
 */

export const X_CONTENT_SCRIPT_ID = 'x-bookmarks'

/** WXT's output path for `entrypoints/x-bookmarks.content.ts`. */
const X_CONTENT_SCRIPT_FILE = '/content-scripts/x-bookmarks.js'

export async function isXContentScriptRegistered(): Promise<boolean> {
  const scripts = await browser.scripting.getRegisteredContentScripts({
    ids: [X_CONTENT_SCRIPT_ID],
  })
  return scripts.length > 0
}

/** Make the registration match `wanted`; a no-op when it already does. */
export async function setXContentScriptRegistered(wanted: boolean): Promise<void> {
  const registered = await isXContentScriptRegistered()
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
 * Tell every already-injected watcher to stop. Unregistering only prevents
 * future injections; a tab that already runs the script would keep
 * reporting. Sent to every tab — the origins may just have been revoked, so
 * a URL-filtered query is not available — and tabs without the script
 * simply have no receiver.
 */
export async function stopInOpenXTabs(): Promise<void> {
  const tabs = await browser.tabs.query({})
  const message: StopXCaptureMessage = { type: X_CAPTURE_STOP_MESSAGE_TYPE }
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) {
        return
      }
      try {
        await browser.tabs.sendMessage(tab.id, message)
      } catch {
        // No content script in this tab.
      }
    }),
  )
}
