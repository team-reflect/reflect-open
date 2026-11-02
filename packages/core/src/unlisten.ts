/**
 * Tears down a subscription: what every `subscribe`, `onXxx` and `listen`
 * returns.
 */
export type Unlisten = () => void

// FIXME: rename this file unlisten.ts to store.ts;

export interface Store<T> {
  get: () => T
  set?: ((value: T) => void) | undefined
  subscribe: (onChange: VoidFunction) => Unlisten
}

export interface WriteableStore<T> extends Store<T> {
  set: (value: T) => void
}
