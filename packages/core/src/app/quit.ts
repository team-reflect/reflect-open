import { z } from 'zod'
import { getBridge, type Unlisten } from '../ipc/bridge.ts'
import { call } from '../ipc/invoke.ts'

/**
 * The quit-time flush handshake. macOS ⌘Q requests app exit without closing
 * the window first, so the window's close-requested flush never runs; the Rust
 * shell defers that exit once and emits {@link QUIT_REQUESTED_EVENT}, the
 * frontend flushes dirty note buffers, then confirms — and the confirm exits
 * for real.
 */

/** Event name the Rust shell emits when it deferred an exit for flushing. */
export const QUIT_REQUESTED_EVENT = 'app:quit-requested'

/** Subscribe to the shell's deferred-quit notification. */
export function subscribeQuitRequested(handler: () => void): Promise<Unlisten> {
  return getBridge().listen(QUIT_REQUESTED_EVENT, () => {
    handler()
  })
}

/**
 * Confirm a deferred quit after flushing. The app exits inside this call, so
 * the returned promise may never settle — fire and forget.
 */
export function confirmQuit(): Promise<void> {
  return call('quit_confirm', {}, z.null()).then(() => undefined)
}

/**
 * Call a deferred quit off: the flush could not preserve every edit and the
 * user chose to keep editing. The Rust handshake is disarmed so no later
 * confirmation exits the app and new windows can open again.
 */
export function cancelQuit(): Promise<void> {
  return call('quit_cancel', {}, z.null()).then(() => undefined)
}
