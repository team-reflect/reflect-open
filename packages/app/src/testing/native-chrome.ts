import type { Unlisten } from '@reflect/core'
import { createTestClockService } from '@reflect/core/testing'
import {
  createNativeChromeService,
  type NativeChromeHost,
  type NativeChromeService,
} from '../mobile/native-chrome-service.ts'

/**
 * A {@link NativeChromeHost} that records the posted messages and sends
 * intents on demand.
 */
export interface TestNativeChromeHost extends NativeChromeHost {
  /**
   * Every message posted so far, oldest first.
   */
  readonly posted: readonly object[]
  /**
   * Deliver an intent as the shell does.
   */
  sendIntent(payload: unknown): void
}

class TestNativeChromeHostImpl implements TestNativeChromeHost {
  readonly posted: object[] = []
  readonly #listeners = new Set<(payload: unknown) => void>()

  post(message: object): void {
    this.posted.push(message)
  }

  listenIntent(listener: (payload: unknown) => void): Unlisten {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  sendIntent(payload: unknown): void {
    for (const listener of this.#listeners) {
      listener(payload)
    }
  }
}

export function createTestNativeChromeHost(): TestNativeChromeHost {
  return new TestNativeChromeHostImpl()
}

/**
 * A {@link NativeChromeService} over `host` with a test clock: enabled with a
 * host, disabled without one.
 */
export function createTestNativeChromeService(host?: NativeChromeHost): NativeChromeService {
  return createNativeChromeService({ host, clock: createTestClockService() })
}
