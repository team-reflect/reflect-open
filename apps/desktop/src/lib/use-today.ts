import { useSyncExternalStore } from 'react'
import { getTodaySnapshot, subscribeToday } from './today-store'

/**
 * Today's ISO date as **live** state: re-renders when the local date changes.
 */
export function useToday(): string {
  return useSyncExternalStore(subscribeToday, getTodaySnapshot, getTodaySnapshot)
}
