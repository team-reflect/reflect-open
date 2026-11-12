import type { Unlisten } from '@reflect/core'
import { listenHostEvent, type SwiftMessageHandler } from '@/services/swift-events.ts'

/**
 * The globals of the Swift shell that carry the native chrome: the flag (a
 * user script sets it before any page script runs) and the `reflectHost`
 * message handler, which also takes the chrome messages.
 */
export interface NativeChromeGlobals {
  readonly __nativeChrome?: boolean | undefined
  readonly webkit?:
    | { messageHandlers?: { reflectHost?: SwiftMessageHandler | undefined } | undefined }
    | undefined
}

let handler: SwiftMessageHandler | undefined

/**
 * Read once whether the shell draws the mobile chrome natively, and mark it
 * on `root` as `data-native-chrome`, so CSS hides the web chrome before the
 * first paint. Off without the Swift shell, so a browser, a Tauri window, and
 * tests draw the web chrome.
 */
export function installNativeChrome(globals: NativeChromeGlobals, root: HTMLElement): void {
  handler =
    globals.__nativeChrome === true ? globals.webkit?.messageHandlers?.reflectHost : undefined
  if (handler === undefined) {
    delete root.dataset.nativeChrome
  } else {
    root.dataset.nativeChrome = ''
  }
}

/**
 * Whether the shell draws the mobile chrome natively.
 */
export function hasNativeChrome(): boolean {
  return handler !== undefined
}

/**
 * Send one chrome message to the shell. A no-op without the native chrome.
 */
export function postNativeChrome(message: unknown): void {
  handler?.postMessage(message)
}

let intentListener: ((payload: unknown) => void) | null = null
let intentSubscribed = false

/**
 * Subscribe to the shell's `chrome:intent` events; returns the unsubscribe.
 * One listener at a time. An intent that arrives with no listener is dropped,
 * never kept for a later listener: it was a tap on a page that is gone.
 */
export function listenNativeIntent(listener: (payload: unknown) => void): Unlisten {
  if (!intentSubscribed) {
    intentSubscribed = true
    listenHostEvent('chrome:intent', (payload) => {
      intentListener?.(payload)
    })
  }
  intentListener = listener
  return () => {
    if (intentListener === listener) {
      intentListener = null
    }
  }
}
