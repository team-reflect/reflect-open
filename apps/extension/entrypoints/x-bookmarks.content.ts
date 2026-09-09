import { browser } from 'wxt/browser'
import { defineContentScript } from '#imports'
import { startBookmarkWatch } from '@/lib/x/bookmark-watch'
import { isStopXCaptureMessage } from '@/lib/x/message-types'
import { X_ORIGINS } from '@/lib/x/origins'
import { messageForChange } from '@/lib/x/report'

type StopListener = (message: unknown) => undefined

declare global {
  interface Window {
    __reflectXBookmarksStop?: () => void
    __reflectXBookmarksStopListener?: StopListener
  }
}

/**
 * The opt-in X watcher (Plan 25). Registered at runtime by the background
 * once the user switches the feature on and grants the origins — never
 * declared in the manifest. Reports every bookmark/like transition to the
 * background, which owns the preferences, the seen-set, and the queue.
 * Idempotent: re-injection (switching the feature on in an open tab, an
 * extension reload) restarts the watcher instead of doubling it.
 */
export default defineContentScript({
  matches: [...X_ORIGINS],
  registration: 'runtime',
  runAt: 'document_idle',
  main() {
    window.__reflectXBookmarksStop?.()
    const stop = startBookmarkWatch(document.body, (change) => {
      browser.runtime.sendMessage(messageForChange(change)).catch((cause: unknown) => {
        // An extension update invalidates this script's context; the next
        // registration replaces it.
        console.warn('Reflect could not report the post:', cause)
      })
    })
    window.__reflectXBookmarksStop = stop

    // Switching the feature off unregisters future injections; this tab's
    // watcher stops on the background's message.
    const previousStopListener = window.__reflectXBookmarksStopListener
    if (previousStopListener) {
      browser.runtime.onMessage.removeListener(previousStopListener)
    }
    const stopListener: StopListener = (message) => {
      if (isStopXCaptureMessage(message)) {
        window.__reflectXBookmarksStop?.()
        delete window.__reflectXBookmarksStop
      }
      return
    }
    window.__reflectXBookmarksStopListener = stopListener
    browser.runtime.onMessage.addListener(stopListener)
  },
})
