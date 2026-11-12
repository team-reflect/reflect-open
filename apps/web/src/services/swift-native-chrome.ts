import type { NativeChromeHost } from '@reflect/app'
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

/**
 * The Swift shell as the native chrome host: messages go to its
 * `reflectHost` handler, and intents come as `chrome:intent` events.
 * `undefined` when the shell draws no native chrome.
 */
export function createSwiftNativeChromeHost(
  globals: NativeChromeGlobals,
): NativeChromeHost | undefined {
  const handler = globals.webkit?.messageHandlers?.reflectHost
  if (globals.__nativeChrome !== true || handler === undefined) {
    return undefined
  }
  return {
    post: (message) => {
      handler.postMessage(message)
    },
    listenIntent: (listener) => {
      return listenHostEvent('chrome:intent', listener)
    },
  }
}
