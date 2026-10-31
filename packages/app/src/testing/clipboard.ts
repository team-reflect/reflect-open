import type { ClipboardService } from '../app/clipboard-service.ts'

export interface TestClipboardService extends ClipboardService {
  writes(): readonly string[]
  /**
   * Make later writes throw `error`; `null` makes them succeed again.
   */
  failWith(error: unknown): void
}

class TestClipboardServiceImpl implements TestClipboardService {
  readonly #written: string[] = []
  #failure: { error: unknown } | null = null

  writeText(text: string): void {
    if (this.#failure !== null) {
      throw this.#failure.error
    }
    this.#written.push(text)
  }

  writes(): readonly string[] {
    return [...this.#written]
  }

  failWith(error: unknown): void {
    this.#failure = error === null ? null : { error }
  }
}

/**
 * A {@link ClipboardService} that records every write.
 */
export function createTestClipboardService(): TestClipboardService {
  return new TestClipboardServiceImpl()
}
