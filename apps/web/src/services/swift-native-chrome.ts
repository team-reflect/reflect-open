import type { NativeChromeHost } from '@reflect/app'
import { listenHostEvent } from '@/services/swift-events.ts'

/**
 * The Swift shell, which always draws the mobile chrome natively: messages
 * go to its `reflectHost` handler, and intents come as `chrome:intent` events.
 */
export function createSwiftNativeChromeHost(target: Window): NativeChromeHost {
  return {
    post: (message) => {
      target.webkit?.messageHandlers?.reflectHost?.postMessage(message)
    },
    listenIntent: (listener) => {
      return listenHostEvent('chrome:intent', listener)
    },
  }
}
