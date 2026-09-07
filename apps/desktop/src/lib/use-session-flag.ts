import { useCallback } from 'react'
import { useSessionStorageExternalStore } from '@/hooks/use-session-storage-external-store'

/**
 * A boolean flag persisted in sessionStorage and shared live across every
 * mounted subscriber of the same key: setting it from one component updates
 * all the others immediately. Bare `useState` seeded from storage would
 * desync components mounted side by side, e.g. one backlinks panel per day
 * in the daily stream, until they remount.
 */
export function useSessionFlag(
  key: string,
  defaultValue: boolean,
): [boolean, (next: boolean) => void] {
  const [stored, setStored] = useSessionStorageExternalStore(key)

  const setValue = useCallback(
    (next: boolean) => {
      setStored(next ? 'true' : 'false')
    },
    [setStored],
  )

  return [stored === null ? defaultValue : stored === 'true', setValue]
}
