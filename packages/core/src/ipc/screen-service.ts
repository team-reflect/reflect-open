import type { LoggerService } from '../ports/logger-service.ts'
import { isMobilePlatform, type PlatformFacts } from '../ports/platform-facts.ts'
import type { Unlisten } from '../unlisten.ts'
import type { IpcBridgeService } from './ipc-service.ts'
import { noop } from '@ocavue/utils'

/**
 * The service over the `plugin:screen` command
 * (`apps/ios/Sources/Capabilities/ScreenCapability.swift`).
 */

/**
 * The screen's auto-lock.
 */
export interface ScreenService {
  /**
   * Keep the screen from locking itself until the returned function is
   * called. Holds nest.
   */
  keepAwake(): Unlisten
}

export interface ScreenServiceDeps {
  readonly ipc: IpcBridgeService
  readonly platform: PlatformFacts
  readonly logger: LoggerService
}

class ShellScreenService implements ScreenService {
  readonly #deps: ScreenServiceDeps
  #holds = 0
  // Sends run one after another, so the shell sees the last state last.
  #sending: Promise<void> = Promise.resolve()

  constructor(deps: ScreenServiceDeps) {
    this.#deps = deps
  }

  keepAwake(): Unlisten {
    this.#holds += 1
    if (this.#holds === 1) {
      this.#send()
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.#holds -= 1
      if (this.#holds === 0) {
        this.#send()
      }
    }
  }

  #send(): void {
    this.#sending = this.#sending.then(async () => {
      const keepAwake = this.#holds > 0
      try {
        await this.#deps.ipc.call('plugin:screen|keep_awake', { keepAwake })
      } catch (cause) {
        this.#deps.logger.error(`failed to set the screen keep-awake state to ${keepAwake}`, cause)
      }
    })
  }
}

/**
 * The desktop screen: embedding work goes on while the display sleeps, so
 * holds change nothing.
 */
class DesktopScreenService implements ScreenService {
  keepAwake(): Unlisten {
    return noop
  }
}

export function createScreenService(deps: ScreenServiceDeps): ScreenService {
  return isMobilePlatform(deps.platform.appPlatform)
    ? new ShellScreenService(deps)
    : new DesktopScreenService()
}
