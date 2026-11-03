import type { WritableStore } from '@reflect/core'
import { useCallback } from 'react'
import { useSelector } from '@/lib/use-store.ts'

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
 * The row `key`'s view of `store`, which holds the key of the list's one open
 * row (`null` when every row is closed). The row re-renders only when it opens
 * or closes, never when another row does.
 */
export function useRevealedRow(store: WritableStore<string | null>, key: string): RevealedRow {
  const isThisRow = useCallback((open: string | null) => open === key, [key])
  const revealed = useSelector(store, isThisRow)
  const reveal = useCallback(() => store.set(key), [store, key])
  const close = useCallback(() => {
    if (store.get() === key) {
      store.set(null)
    }
  }, [store, key])
  const beginInteraction = useCallback(() => {
    if (store.get() !== key) {
      store.set(null)
    }
  }, [store, key])
  return { revealed, reveal, close, beginInteraction }
}
