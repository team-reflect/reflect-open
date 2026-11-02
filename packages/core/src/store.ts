import type { Unlisten } from './unlisten.ts'

/**
 * A value that changes over time, and a way to hear about the changes.
 */
export interface Store<T> {
  /**
   * Returns the current value. It must return the same reference until the value changes.
   */
  get: () => T
  /**
   * Subscribes to changes. Returns an `Unlisten` function to tear down the subscription.
   */
  subscribe: (listener: VoidFunction) => Unlisten
}

/**
 * A {@link Store} that holds its value and notifies on {@link set}.
 */
export class WritableStore<T> implements Store<T> {
  #value: T
  readonly #listeners = new Set<() => void>()
  readonly #isEqual: (a: T, b: T) => boolean

  constructor(value: T, isEqual: (a: T, b: T) => boolean = Object.is) {
    this.#value = value
    this.#isEqual = isEqual
  }

  readonly get = (): T => {
    return this.#value
  }

  /**
   * Replaces the value and notifies the listeners. An equal value is ignored.
   */
  readonly set = (value: T): void => {
    if (this.#isEqual(this.#value, value)) {
      return
    }
    this.#value = value
    for (const listener of this.#listeners) {
      listener()
    }
  }

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Whether the store has any listener.
   */
  subscribed(): boolean {
    return this.#listeners.size > 0
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
  return combineStores([store], derive, isEqual)
}

function isArrayShallowEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/**
 * A {@link Store} of `derive(...values)`, where `values` are the current
 * values of `stores`. A new result that `isEqual` to the previous one is
 * dropped, so `get` keeps the previous reference and subscribers are not
 * notified.
 *
 * `derive` runs again only when one of `stores` returns a new reference. The
 * combined store subscribes to `stores` only while it has subscribers.
 */
export function combineStores<T extends unknown[], U>(
  stores: { [K in keyof T]: Store<T[K]> },
  derive: (...values: T) => U,
  isEqual: (a: U, b: U) => boolean = Object.is,
): Store<U> {
  let sources: T | undefined
  let derived: U

  const get = (): U => {
    const newSources: T = stores.map((store) => store.get()) as T
    if (sources && isArrayShallowEqual(sources, newSources)) {
      return derived
    }
    const newDerived: U = derive(...newSources)
    if (!sources || !isEqual(derived, newDerived)) {
      derived = newDerived
    }
    sources = newSources
    return derived
  }

  const subscribe = (listener: VoidFunction): Unlisten => {
    let last = get()
    const onChange = () => {
      const next = get()
      if (next !== last) {
        last = next
        listener()
      }
    }
    const unlistens = stores.map((store) => store.subscribe(onChange))
    return () => {
      for (const unlisten of unlistens) {
        unlisten()
      }
    }
  }

  return { get, subscribe }
}
