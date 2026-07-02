import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'

/**
 * The app-lifetime deep-link intake. The OS delivers `reflect://` URLs to the
 * app as a whole, but they can only be *acted on* inside an open graph (the
 * router and the capture inbox are graph-scoped), so this module decouples
 * the two lifetimes: {@link startDeepLinkListener} subscribes exactly once
 * per app run, and URLs buffer here until a workspace's handler is attached —
 * a link that launched the app, or arrived on the graph chooser, fires the
 * moment the graph opens instead of being dropped.
 */

let pendingUrls: string[] = []
let activeHandler: ((url: string) => void) | null = null
let started = false

function deliverDeepLink(url: string): void {
  if (activeHandler !== null) {
    activeHandler(url)
  } else {
    pendingUrls.push(url)
  }
}

/**
 * Attach the workspace's handler (or detach with null on unmount). Attaching
 * drains any URLs that arrived while no graph was open, in arrival order.
 */
export function setDeepLinkHandler(handler: ((url: string) => void) | null): void {
  activeHandler = handler
  if (handler !== null && pendingUrls.length > 0) {
    const queued = pendingUrls
    pendingUrls = []
    for (const url of queued) {
      handler(url)
    }
  }
}

/**
 * Subscribe to the deep-link plugin once for the app's lifetime: the
 * `deep-link://new-url` event stream (`onOpenUrl`) for URLs that arrive while
 * running, then `getCurrent` for the URL the app was launched with —
 * `onOpenUrl` alone does not replay it. Subscribing before the `getCurrent`
 * read means a URL landing in the startup gap is doubled rather than dropped;
 * doubling is benign (navigation is idempotent, and the capture drain's
 * exact-line dedupe absorbs a repeated append). Idempotent: the subscription
 * is never torn down, so a re-render or StrictMode double-mount can't
 * re-deliver the launch URL.
 */
export async function startDeepLinkListener(): Promise<void> {
  if (started) {
    return
  }
  started = true
  let unlisten: (() => void) | null = null
  try {
    unlisten = await onOpenUrl((urls) => {
      for (const url of urls) {
        deliverDeepLink(url)
      }
    })
    for (const url of (await getCurrent()) ?? []) {
      deliverDeepLink(url)
    }
  } catch (cause) {
    // Unlatch so a later call can retry — a failed start must not disable
    // deep links for the rest of the app run. If the subscription itself
    // succeeded (`getCurrent` failed), tear it down first, or the retry
    // would stack a second subscription and double-deliver every URL.
    unlisten?.()
    started = false
    throw cause
  }
}

/** Test-only: reset the module state between cases. */
export function resetDeepLinkIntakeForTests(): void {
  pendingUrls = []
  activeHandler = null
  started = false
}
