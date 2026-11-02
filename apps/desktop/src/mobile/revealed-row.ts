import { useCallback, useSyncExternalStore } from 'react'

/**
 * The key of the one row in a list whose swipe actions show. Each row
 * subscribes to its own key, so a change re-renders only the row that opens
 * and the row that closes, never the whole list.
 */
export class RevealedRowStore {
  #key: string | null = null
  readonly #listeners = new Set<() => void>()

  /**
   * The key of the open row, or `null` when every row is closed.
   */
  getKey = (): string | null => this.#key

  /**
   * Opens the row `key` (closing the previous one), or closes every row with
   * `null`. Notifies the listeners only when the key changes.
   */
  setKey = (key: string | null): void => {
    if (key === this.#key) {
      return
    }
    this.#key = key
    for (const listener of this.#listeners) {
      listener()
    }
  }

  /**
   * Calls `listener` after every key change. Returns the unsubscribe function.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}

/**
 * One row's state and callbacks, from `useRevealedRow`.
 */
export interface RevealedRow {
  /**
   * Whether this row is the open one.
   */
  revealed: boolean
  /**
   * Opens this row and closes the row that was open.
   */
  reveal: () => void
  /**
   * Closes this row. Does nothing when another row is the open one.
   */
  close: () => void
  /**
   * Closes any other open row, for every press on this row (a tap included).
   */
  beginInteraction: () => void
}

/**
 * The row `key`'s view of `store`.
 */
export function useRevealedRow(store: RevealedRowStore, key: string): RevealedRow {
  const revealed = useSyncExternalStore(store.subscribe, () => store.getKey() === key)
  const reveal = useCallback(() => store.setKey(key), [store, key])
  const close = useCallback(() => {
    if (store.getKey() === key) {
      store.setKey(null)
    }
  }, [store, key])
  const beginInteraction = useCallback(() => {
    if (store.getKey() !== key) {
      store.setKey(null)
    }
  }, [store, key])
  return { revealed, reveal, close, beginInteraction }
}
