import type { MaybePromise } from '@reflect/utils'
import {
  listenNow,
  type ActivityPort,
  type BackgroundTaskToken,
  type ClockService,
  type IpcBridgeService,
  type LoggerService,
  type TimerHandle,
  type Unlisten,
} from '@reflect/core'
import { z } from 'zod'

/**
 * The shell's notice that it deferred an app exit so the frontend can flush.
 */
export const QUIT_REQUESTED_EVENT = 'app:quit-requested'

/**
 * The shortest gap between two resume callbacks of one subscription.
 */
export const RESUME_THROTTLE_MS = 1_500

const backgroundTaskTokenSchema = z.string()

/**
 * The page events an {@link AppLifecycleService} observes.
 */
export type LifecyclePageEvent = 'focus' | 'online' | 'pagehide' | 'beforeunload'

/**
 * The DOM behind an {@link AppLifecycleService}.
 */
export interface LifecycleDomAdapter {
  /**
   * Add a listener for a window event; returns its remover.
   */
  onPageEvent(type: LifecyclePageEvent, listener: () => void): Unlisten
  /**
   * Add a listener for document visibility changes; returns its remover.
   */
  onVisibilityChange(listener: () => void): Unlisten
  isHidden(): boolean
}

/**
 * Application lifecycle signals and the shell's quit and background-task handshakes.
 */
export interface AppLifecycleService extends ActivityPort {
  subscribePageHide(listener: () => void): Unlisten
  subscribeBeforeUnload(listener: () => void): Unlisten
  /**
   * Listen for an exit the shell deferred until the frontend flushes.
   */
  subscribeQuitRequested(listener: () => void): Unlisten
  /**
   * Confirm a deferred quit. The app exits inside this call, so the promise may never settle.
   */
  confirmQuit(): MaybePromise<void>
}

export interface LifecycleServiceDeps {
  readonly ipc: IpcBridgeService
  readonly dom: LifecycleDomAdapter
  readonly clock: ClockService
  readonly logger: LoggerService
}

class LifecycleServiceImpl implements AppLifecycleService {
  readonly #deps: LifecycleServiceDeps

  constructor(deps: LifecycleServiceDeps) {
    this.#deps = deps
  }

  subscribeResume(listener: () => void): Unlisten {
    const { clock } = this.#deps
    let canceled = false
    let windowStart = -Infinity
    let timer: TimerHandle | null = null
    const fire = (): void => {
      windowStart = clock.now()
      listener()
    }
    // Leading and trailing: the first call fires, later calls in the window collapse into one.
    const handleResume = (): void => {
      if (canceled) {
        return
      }
      if (timer !== null) {
        clock.clearTimeout(timer)
        timer = null
      }
      const now = clock.now()
      if (now - windowStart >= RESUME_THROTTLE_MS) {
        fire()
        return
      }
      timer = clock.setTimeout(
        () => {
          timer = null
          fire()
        },
        RESUME_THROTTLE_MS + windowStart - now,
      )
    }
    const removeWake = this.subscribeWake(handleResume)
    const removeVisible = this.#subscribeVisibility(true, handleResume)
    return () => {
      canceled = true
      if (timer !== null) {
        clock.clearTimeout(timer)
        timer = null
      }
      removeWake()
      removeVisible()
    }
  }

  subscribeWake(listener: () => void): Unlisten {
    const { dom } = this.#deps
    const removeFocus = dom.onPageEvent('focus', listener)
    const removeOnline = dom.onPageEvent('online', listener)
    return () => {
      removeFocus()
      removeOnline()
    }
  }

  subscribeFocus(listener: () => void): Unlisten {
    return this.#deps.dom.onPageEvent('focus', listener)
  }

  subscribeVisible(listener: () => void): Unlisten {
    return this.#subscribeVisibility(true, listener)
  }

  subscribeHidden(listener: () => void): Unlisten {
    return this.#subscribeVisibility(false, listener)
  }

  subscribePageHide(listener: () => void): Unlisten {
    return this.#deps.dom.onPageEvent('pagehide', listener)
  }

  subscribeBeforeUnload(listener: () => void): Unlisten {
    return this.#deps.dom.onPageEvent('beforeunload', listener)
  }

  isHidden(): boolean {
    return this.#deps.dom.isHidden()
  }

  subscribeQuitRequested(listener: () => void): Unlisten {
    const { ipc, logger } = this.#deps
    return listenNow(
      () => {
        return ipc.listen(QUIT_REQUESTED_EVENT, () => {
          listener()
        })
      },
      (cause) => {
        logger.error(`${QUIT_REQUESTED_EVENT} listener failed:`, cause)
      },
    )
  }

  async confirmQuit(): Promise<void> {
    await this.#deps.ipc.call('quit_confirm', {}, z.null())
  }

  beginBackgroundTask(): Promise<BackgroundTaskToken | null> {
    return this.#deps.ipc.call('background_task_begin', {}, backgroundTaskTokenSchema.nullable())
  }

  async endBackgroundTask(token: BackgroundTaskToken): Promise<void> {
    await this.#deps.ipc.call('background_task_end', { token }, z.null())
  }

  #subscribeVisibility(visible: boolean, listener: () => void): Unlisten {
    const { dom } = this.#deps
    return dom.onVisibilityChange(() => {
      if (dom.isHidden() !== visible) {
        listener()
      }
    })
  }
}

export function createLifecycleService(deps: LifecycleServiceDeps): AppLifecycleService {
  return new LifecycleServiceImpl(deps)
}
