import { useSessionFlag } from '@/lib/use-session-flag'

/** Session-wide (all notes) expanded state, old Reflect's `backlinks-expanded`. */
const EXPANDED_STORAGE_KEY = 'reflect.backlinks-expanded'

/**
 * The incoming-backlinks section's expanded state: one flag for the whole
 * session, shared live across every mounted surface — the desktop daily
 * stream shows one panel per day (and the mobile carousel one per mounted
 * slide), and the header toggle must move them together, not just the
 * instance that was tapped.
 */
export function useBacklinksExpanded(): [boolean, (next: boolean) => void] {
  return useSessionFlag(EXPANDED_STORAGE_KEY, true)
}
