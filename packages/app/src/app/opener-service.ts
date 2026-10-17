import type { MaybePromise } from '@reflect/utils'
import { errorMessage, type LoggerService } from '@reflect/core'

/**
 * A macOS System Settings privacy pane.
 */
export type SystemSettingsPane = 'calendar' | 'contacts'

/**
 * Hands URLs and paths to the operating system.
 */
export interface OpenerService {
  /**
   * Open `url` with its default handler.
   */
  openUrl(url: string): Promise<void>
  /**
   * {@link openUrl} without a promise; a failure is logged.
   */
  openUrlSync(url: string): void
  /**
   * Show `path` in the system file manager.
   */
  revealInFileManager(path: string): Promise<void>
  /**
   * Open a System Settings privacy pane; a failure is logged.
   */
  openSystemSettings(pane: SystemSettingsPane): void
}

/**
 * The native operations behind an {@link OpenerService}.
 */
export interface OpenerTransport {
  openUrl(url: string): MaybePromise<void>
  revealItemInDir(path: string): MaybePromise<void>
}

const SYSTEM_SETTINGS_URLS: Record<SystemSettingsPane, string> = {
  calendar: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
  contacts: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts',
}

export interface OpenerServiceDeps {
  readonly transport: OpenerTransport
  readonly logger: LoggerService
}

class OpenerServiceImpl implements OpenerService {
  readonly #deps: OpenerServiceDeps

  constructor(deps: OpenerServiceDeps) {
    this.#deps = deps
  }

  async openUrl(url: string): Promise<void> {
    await this.#deps.transport.openUrl(url)
  }

  openUrlSync(url: string): void {
    const { transport, logger } = this.#deps
    void (async () => {
      try {
        await transport.openUrl(url)
      } catch (cause: unknown) {
        logger.error(`failed to open ${url}:`, errorMessage(cause))
      }
    })()
  }

  async revealInFileManager(path: string): Promise<void> {
    await this.#deps.transport.revealItemInDir(path)
  }

  openSystemSettings(pane: SystemSettingsPane): void {
    this.openUrlSync(SYSTEM_SETTINGS_URLS[pane])
  }
}

export function createOpenerService(deps: OpenerServiceDeps): OpenerService {
  return new OpenerServiceImpl(deps)
}
