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

export interface WriteableStore<T> extends Store<T> {
  set: (value: T) => void
}
