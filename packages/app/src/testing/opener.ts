import { createTestLoggerService } from '@reflect/core/testing'
import type { LoggerService } from '@reflect/core'
import {
  createOpenerService,
  type OpenerService,
  type SystemSettingsPane,
} from '../app/opener-service.ts'

export interface TestOpenerService extends OpenerService {
  openedUrls(): readonly string[]
  revealedPaths(): readonly string[]
  /**
   * Make later opens and reveals reject with `error`; `null` makes them succeed again.
   */
  failWith(error: unknown): void
}

/**
 * Forwards every member to the real service, over a transport that records.
 */
class TestOpenerServiceImpl implements TestOpenerService {
  readonly #inner: OpenerService
  readonly #opened: string[] = []
  readonly #revealed: string[] = []
  #failure: { error: unknown } | null = null

  constructor(logger: LoggerService) {
    this.#inner = createOpenerService({
      transport: {
        openUrl: (url) => {
          if (this.#failure !== null) {
            throw this.#failure.error
          }
          this.#opened.push(url)
        },
        revealItemInDir: (path) => {
          if (this.#failure !== null) {
            throw this.#failure.error
          }
          this.#revealed.push(path)
        },
      },
      logger,
    })
  }

  openUrl(url: string): Promise<void> {
    return this.#inner.openUrl(url)
  }

  openUrlSync(url: string): void {
    this.#inner.openUrlSync(url)
  }

  revealInFileManager(path: string): Promise<void> {
    return this.#inner.revealInFileManager(path)
  }

  openSystemSettings(pane: SystemSettingsPane): void {
    this.#inner.openSystemSettings(pane)
  }

  openedUrls(): readonly string[] {
    return [...this.#opened]
  }

  revealedPaths(): readonly string[] {
    return [...this.#revealed]
  }

  failWith(error: unknown): void {
    this.#failure = error === null ? null : { error }
  }
}

/**
 * An {@link OpenerService} that records every URL and path instead of opening it.
 */
export function createTestOpenerService(options?: { logger?: LoggerService }): TestOpenerService {
  return new TestOpenerServiceImpl(options?.logger ?? createTestLoggerService())
}
