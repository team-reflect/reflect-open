/**
 * State is a {@link Store}: `get` plus `subscribe`. A value that answers "what
 * is it now" is a `Store`. Something that only answers "what just happened" is
 * an event and stays a plain callback.
 *
 * Shape of a service:
 *
 * - One value: the service `extends Store<T>` and forwards `get` and
 *   `subscribe` of a private {@link WritableStore}.
 * - A main value plus extra state (a status, an error): the service extends
 *   the main value's `Store`, and each extra state is a `readonly` `Store`
 *   member.
 * - Values that must change together: one private `WritableStore` holds all of
 *   them and one `set` writes them. Each public `Store` is a
 *   {@link deriveStore} of it.
 * - A value derived from other services: {@link deriveStore} or
 *   {@link combineStores}, created in the constructor. Never subscribe to a
 *   source in the constructor to copy it into a `WritableStore`.
 * - Work that runs only while someone listens: start it in `subscribe`, and
 *   stop it after an `Unlisten` when {@link WritableStore.subscribed} is
 *   false. Do not count subscribers. Do not add a `start()` or `attach()`
 *   method for a React effect to call.
 * - A value has one owner service. Other code reads it from that service and
 *   writes it through that service's methods. It never computes the value
 *   itself. For example, today's date comes from `TodayService`.
 *
 * Rules:
 *
 * - `get` returns the same reference until the value changes. Never build a
 *   new object in `get`.
 * - Values are immutable. A write sets a new object and keeps the references
 *   of unchanged fields.
 * - `get`, `subscribe`, and any member that is passed around are arrow
 *   function properties. Other members are methods.
 * - The private `WritableStore` that holds the service's main value is named
 *   `#store`.
 * - A `Store` service has no other member that returns data `get` already
 *   returns, such as `list()` or `state()`.
 * - Pass a `Store`, not a separate `get` and `subscribe`.
 * - `WritableStore` holds a listener once, so subscribe each time with a
 *   fresh function.
 * - Logic that reads a value and writes it back is a service method, not code
 *   at the call site.
 * - A source notifies on every change and may notify more often. The derived
 *   layer (`deriveStore`, `combineStores`, `useSelector`) drops a notification
 *   whose result is unchanged, so a source needs no extra caching or finer
 *   state for exact notifications. To feed another service, build a `Store` in
 *   place from an existing `get` and `subscribe` instead of changing a port.
 * - Never notify when the value is unchanged. A different thing that changes
 *   is its own `Store`.
 * - `WritableStore` compares with `Object.is` by default. When the writer
 *   builds a new value each time (from a payload or from private fields), pass
 *   `isShallowEqual` or `isDeepEqual`. Do not hand-write an equality
 *   function that one of them can replace.
 * - Notifications are synchronous. Values that must be seen together go in one
 *   `set`. One change is one `set`, so a subscriber never sees a half-done
 *   state.
 *
 * React reads a `Store` with `useStore` or `useSelector`. A selector and its
 * `isEqual` must be stable: a module-level function, or `useCallback`. A
 * component reads only the fields it renders, at the precision it renders
 * them: select whole seconds from a store that ticks in milliseconds. A
 * context holds services and actions, never state.
 *
 * Tests of a `Store` cover: `get` keeps its reference after an unrelated write,
 * an equal write does not notify, a derived `Store` does not notify when an
 * unrelated field changes, and nothing is notified after unsubscribe. A test
 * fake forwards the `Store` members of the real service instead of keeping
 * its own listeners.
 */

import { isShallowEqual } from '@ocavue/utils'
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
    if (sources && isShallowEqual(sources, newSources)) {
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
