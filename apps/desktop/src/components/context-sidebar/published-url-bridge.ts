import { useSyncExternalStore } from 'react'

interface PendingPublishedUrl {
  readonly path: string
  readonly url: string
}

let pendingPublishedUrl: PendingPublishedUrl | null = null
const listeners = new Set<() => void>()

function emitChange(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): PendingPublishedUrl | null {
  return pendingPublishedUrl
}

/**
 * Holds a freshly published URL until the index row catches up, so every
 * sidebar surface can reflect the successful publish immediately.
 */
export function setPendingPublishedUrl(path: string, url: string): void {
  pendingPublishedUrl = { path, url }
  emitChange()
}

/**
 * Clears the pending URL for a note once the index reports the same value.
 */
export function clearPendingPublishedUrl(path: string, url: string): void {
  if (pendingPublishedUrl?.path !== path || pendingPublishedUrl.url !== url) {
    return
  }
  pendingPublishedUrl = null
  emitChange()
}

/**
 * Returns the pending published URL for `path`, if a publish completed before
 * the index row was refreshed.
 */
export function usePendingPublishedUrl(path: string): string | null {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return snapshot?.path === path ? snapshot.url : null
}
