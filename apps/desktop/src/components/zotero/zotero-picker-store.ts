import { useSyncExternalStore } from 'react'

/**
 * Open state for the Zotero item picker. Module-level rather than a provider
 * (the formatting-toolbar-store pattern): the picker's only readers are the
 * dialog and the app-shortcuts modal guard, and its only writers are the
 * palette command and the `/` menu row — none of which need React state or
 * re-renders at the call site. The target note path is captured at open time,
 * so the dialog needs no `CommandContext` of its own.
 */

export interface ZoteroPickerState {
  /** The graph-relative path of the note the picked link inserts into. */
  targetPath: string | null
  /** Bumped on every open so the dialog remounts with fresh search state. */
  epoch: number
}

let state: ZoteroPickerState | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Open the picker for `targetPath` (the note whose editor receives the link). */
export function openZoteroPicker(targetPath: string | null): void {
  state = { targetPath, epoch: (state?.epoch ?? 0) + 1 }
  notify()
}

/** Close the picker without inserting anything. */
export function closeZoteroPicker(): void {
  state = null
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): ZoteroPickerState | null {
  return state
}

/** The picker's open state as reactive state — null while closed. */
export function useZoteroPicker(): ZoteroPickerState | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
