/**
 * Event-loop pacing for the long index passes. A pass over thousands of
 * notes parses and hashes on the webview's only thread; without explicit
 * breaks the UI (and on iOS the whole app) reads as frozen even though the
 * per-file awaits technically yield. A real macrotask break every
 * {@link INDEX_PASS_YIELD_EVERY} files gives rendering and input a slot.
 */

/** Files processed between event-loop breaks in an index pass. */
import { sleep } from '@ocavue/utils'
export const INDEX_PASS_YIELD_EVERY = 16

/** Complete after a macrotask turn, letting rendering and input run. */
export function yieldToEventLoop(): Promise<void> {
  return sleep(0)
}
