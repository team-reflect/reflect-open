import { WritableStore, type Store } from '@reflect/core'

/**
 * The software keyboard's overlap height in px, as the UI last measured it:
 * `0` when the keyboard is closed. Imperative consumers read `get()` (a swipe
 * guard fires at drag start, outside any render); reactive ones subscribe.
 * Members are function properties so surfaces can pass them around unbound.
 */
export interface KeyboardService extends Store<number> {
  /**
   * Record the keyboard overlap height. A height equal to the current one notifies nobody.
   */
  publish(height: number): void
}

class KeyboardServiceImpl implements KeyboardService {
  readonly #height = new WritableStore(0)

  readonly get = this.#height.get

  readonly subscribe = this.#height.subscribe

  publish(height: number): void {
    this.#height.set(height)
  }
}

export function createKeyboardService(): KeyboardService {
  return new KeyboardServiceImpl()
}
