import type { MaybePromise } from '@reflect/utils'
import type { Unlisten } from '../unlisten.ts'

/**
 * Opaque handle for one finite-length native background execution assertion.
 */
export type BackgroundTaskToken = string

/**
 * The app activity signals that business services follow, and the native
 * background-task handshake.
 */
export interface ActivityPort {
  /**
   * Window focus, network back, or the page turning visible; throttled per subscription.
   */
  subscribeResume(listener: () => void): Unlisten
  /**
   * Window focus or network back, unthrottled.
   */
  subscribeWake(listener: () => void): Unlisten
  /**
   * Window focus alone, unthrottled.
   */
  subscribeFocus(listener: () => void): Unlisten
  subscribeVisible(listener: () => void): Unlisten
  subscribeHidden(listener: () => void): Unlisten
  isHidden(): boolean
  /**
   * Ask the shell to keep running after the OS backgrounds the app; `null` when unavailable.
   */
  beginBackgroundTask(): MaybePromise<BackgroundTaskToken | null>
  /**
   * Balance {@link beginBackgroundTask}. Expired or repeated tokens are no-ops.
   */
  endBackgroundTask(token: BackgroundTaskToken): MaybePromise<void>
}
