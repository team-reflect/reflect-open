import { useSyncExternalStore } from 'react'
import { hasBridge, subscribeBridgeChanges } from '@reflect/core'

/**
 * Reactive `hasBridge()` for React code. The Tauri bridge installs before the
 * first render, but the browser dev bridge installs *asynchronously* after
 * it — a component that samples `hasBridge()` during render keeps the stale
 * answer forever (a disabled query never re-enables). Subscribing through
 * `useSyncExternalStore` re-renders the component when `setBridge` runs, so
 * bridge-gated UI comes alive the moment the install lands. Components and
 * hooks must use this instead of calling `hasBridge()` in render scope
 * (query `enabled:` flags, rendered booleans, effect guards); imperative
 * callbacks and non-React modules keep calling `hasBridge()` at their own
 * call time.
 */
export function useBridgeReady(): boolean {
  return useSyncExternalStore(subscribeBridgeChanges, hasBridge, hasBridge)
}
