import { AppError, type Unlisten } from '@reflect/core'

/**
 * The object the Swift shell injects as `window.__reflectHost` before any
 * page script runs. Its listener registry delivers the shell's events: the
 * shell calls `dispatch(name, payload)` and every handler of `name` runs.
 */
export interface ReflectHost {
  /**
   * Subscribe to a shell event; returns the unsubscribe.
   */
  on(name: string, handler: (payload: unknown) => void): Unlisten
}

declare global {
  interface Window {
    __reflectHost?: ReflectHost | undefined
  }
}

/**
 * Subscribe to an event of the Swift shell through `window.__reflectHost`.
 * Throws an `io` error when the page runs outside the Swift shell.
 */
export function listenHostEvent(name: string, handler: (payload: unknown) => void): Unlisten {
  const host = window.__reflectHost
  if (host === undefined) {
    throw new AppError('io', `no Swift host delivers "${name}"`)
  }
  // FIXME: 1. let's do not put all files under a swift-host/ sub dir. We want to match existing tauri-xxxx.ts patterns.
  // FIXME: 2. this file should not call host-events.ts because it's clear thtat this is swift only.
  return host.on(name, handler)
}
