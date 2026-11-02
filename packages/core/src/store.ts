import type { Unlisten } from './unlisten.ts'

/**
 * A value that changes over time, and a way to hear about the changes.
 */
export interface Store<T> {
  /**
   * Returns the current value.
   * `get` must return the same reference until the value changes.
   */
  get: () => T
  /**
   * Subscribe to changes. The listener is called after the value changed.
   * Returns an `Unlisten` function to tear down the subscription.
   */
  subscribe: (listener: VoidFunction) => Unlisten
}

/**
 * A {@link Store} that holds its value and notifies on {@link set}.
 */
export class WriteableStore<T> implements Store<T> {
  #value: T
  readonly #listeners = new Set<() => void>()

  constructor(value: T) {
    this.#value = value
  }

  readonly get = (): T => {
    return this.#value
  }

  /**
   * Replace the value. An identical value (`===`) is ignored. With
   * `emit: false` the caller must call {@link emit} itself, for example to
   * notify once after other state changed as well.
   */
  readonly set = (value: T, emit: boolean = true): void => {
    if (this.#value === value) return
    this.#value = value
    if (emit) {
      this.emit()
    }
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Call every listener, whether or not the value changed.
   */
  readonly emit = (): void => {
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

/**
 * A {@link Store} of `derive(store.get())`. A new result that `isEqual` to the
 * previous one is dropped, so `get` keeps the previous reference and
 * subscribers are not notified.
 *
 * `derive` runs again only when `store.get()` returns a new reference.
 */
export function deriveStore<T, U>(
  store: Store<T>,
  derive: (value: T) => U,
  isEqual: (a: U, b: U) => boolean = Object.is,
): Store<U> {
  let source: T
  let derived: U
  let initialized = false

  const get = (): U => {
    const next = store.get()
    if (initialized && next === source) {
      return derived
    }
    const value = derive(next)
    if (!initialized || !isEqual(derived, value)) {
      derived = value
    }
    source = next
    initialized = true
    return derived
  }

  const subscribe = (listener: () => void): Unlisten => {
    let last = get()
    return store.subscribe(() => {
      const next = get()
      if (next !== last) {
        last = next
        listener()
      }
    })
  }

  return { get, subscribe }
}
