import type { Unlisten } from '@reflect/core'

/**
 * The software keyboard's overlap height, as the UI last measured it.
 * Imperative consumers read {@link KeyboardService.getHeight} (a swipe guard
 * fires at drag start, outside any render); reactive ones subscribe. Members
 * are function properties so surfaces can pass them around unbound.
 */
export interface KeyboardService {
  /**
   * The last published keyboard overlap in px: `0` when the keyboard is closed.
   */
  getHeight: () => number
  /**
   * Whether the software keyboard is up.
   */
  isVisible: () => boolean
  /**
   * Listen for a changed height.
   */
  subscribe: (listener: () => void) => Unlisten
  /**
   * Record the keyboard overlap height. A height equal to the current one notifies nobody.
   */
  publish(height: number): void
}

class KeyboardServiceImpl implements KeyboardService {
  readonly #listeners = new Set<() => void>()
  #currentHeight = 0

  readonly getHeight = (): number => this.#currentHeight

  readonly isVisible = (): boolean => this.#currentHeight > 0

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  publish(height: number): void {
    if (height === this.#currentHeight) {
      return
    }
    this.#currentHeight = height
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

export function createKeyboardService(): KeyboardService {
  return new KeyboardServiceImpl()
}
