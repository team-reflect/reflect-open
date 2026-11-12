import type { Unlisten } from '@reflect/core'
import { listenHostEvent, type SwiftMessageHandler } from '@/services/swift-events.ts'

/**
 * The parts of the mobile chrome that the Swift shell can draw natively.
 */
export const NATIVE_CHROME_FEATURES = ['menus', 'toolbar', 'tabbar', 'navbar'] as const

export type NativeChromeFeature = (typeof NATIVE_CHROME_FEATURES)[number]

/**
 * The globals of the Swift shell that carry the native chrome: the feature
 * list (a user script sets it before any page script runs) and the
 * `reflectChrome` message handler.
 */
export interface NativeChromeGlobals {
  readonly __nativeChromeFeatures?: readonly unknown[] | undefined
  readonly webkit?:
    | {
        messageHandlers?:
          | {
              reflectHost?: SwiftMessageHandler | undefined
              reflectChrome?: SwiftMessageHandler | undefined
            }
          | undefined
      }
    | undefined
}

/**
 * The parts the shell draws. Empty without the Swift shell and its
 * `reflectChrome` handler, so a browser, a Tauri window, and tests draw the
 * web chrome.
 */
export function readNativeChromeFeatures(
  globals: NativeChromeGlobals,
): ReadonlySet<NativeChromeFeature> {
  const handlers = globals.webkit?.messageHandlers
  if (handlers?.reflectHost === undefined || handlers.reflectChrome === undefined) {
    return new Set()
  }
  const listed = globals.__nativeChromeFeatures ?? []
  return new Set(
    NATIVE_CHROME_FEATURES.filter((feature) => {
      return listed.includes(feature)
    }),
  )
}

let features: ReadonlySet<NativeChromeFeature> = new Set()
let handler: SwiftMessageHandler | undefined

/**
 * Read the shell's features once and mark them on `root` as
 * `data-native-chrome`, so CSS hides the web parts before the first paint.
 */
export function installNativeChrome(globals: NativeChromeGlobals, root: HTMLElement): void {
  features = readNativeChromeFeatures(globals)
  handler = features.size > 0 ? globals.webkit?.messageHandlers?.reflectChrome : undefined
  if (features.size > 0) {
    root.dataset.nativeChrome = [...features].join(' ')
  } else {
    delete root.dataset.nativeChrome
  }
}

/**
 * Whether the shell draws `feature`.
 */
export function hasNativeChrome(feature: NativeChromeFeature): boolean {
  return features.has(feature)
}

/**
 * Whether the shell draws any part, and so needs the chrome state.
 */
export function hasAnyNativeChrome(): boolean {
  return features.size > 0
}

/**
 * Send one message to the shell's `reflectChrome` handler. A no-op without it.
 */
export function postNativeChrome(message: unknown): void {
  handler?.postMessage(message)
}

/**
 * Subscribe to the shell's `chrome:intent` events; returns the unsubscribe.
 */
export function listenNativeIntent(listener: (payload: unknown) => void): Unlisten {
  return listenHostEvent('chrome:intent', listener)
}
