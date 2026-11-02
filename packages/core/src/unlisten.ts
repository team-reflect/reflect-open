/**
 * Tears down a subscription: what every `subscribe`, `onXxx` and `listen`
 * returns.
 */
export type Unlisten = () => void

// FIXME: rename this file unlisten.ts to store.ts;

interface Store<T> {
  get: () => T
  set?: ((value: T) => void) | undefined
  subscribe: (listener: VoidFunction) => Unlisten
}

interface WriteableStore<T> extends Store<T> {
  set: (value: T) => void
}
