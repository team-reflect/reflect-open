/**
 * Tears down a subscription: what every `subscribe`, `onXxx` and `listen`
 * returns.
 */
export type Unlisten = () => void

// FIXME: rename this file unlisten.ts to store.ts;

export interface Store<T> {
  // Use comment to explain that the return value of `get` should be stable and not change between calls unless the store has changed.
  get: () => T
  subscribe: (onChange: VoidFunction) => Unlisten
}

export class WriteableStore<T> {
  #value: T
  readonly #listeners = new Set<() => void>()

  constructor(value: T) {
    this.#value = value
  }

  get(): T {
    return this.#value
  }

  set(value: T, emit: boolean = true): void {
    if (this.#value === value) return
    this.#value = value
    if (emit) {
      this.emit()
    }
  }

  subscribe(listener: () => void): Unlisten {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  emit(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

export function deriveStore<T, U>(
  store: Store<T>,
  deriveFn: (value: T) => U,
  isEqual: (a: U, b: U) => boolean = Object.is,
): Store<U> {
  let derived: U | undefined

  const get = (): U => {
    const storeValue = store.get()
    const newDerived = deriveFn(storeValue)
    if (derived === undefined || !isEqual(derived, newDerived)) {
      derived = newDerived
    }
    return derived
  }

  return { get, subscribe: store.subscribe }
}
