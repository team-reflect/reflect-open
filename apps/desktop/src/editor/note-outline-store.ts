import { parseNote, type Heading } from '@reflect/core'

type Listener = () => void

/**
 * Live note outlines, keyed by graph-relative note path. The note pane
 * (publisher) parses headings on edit and calls {@link publishOutline}; the
 * context sidebar (subscriber) reads them through `useSyncExternalStore`.
 * Module-level rather than a provider — the pane and the sidebar are siblings
 * that never share a React parent below the workspace, the same shape as
 * {@link file://./editor-handle-registry.ts}.
 */
const EMPTY: readonly Heading[] = Object.freeze([])
const outlines = new Map<string, readonly Heading[]>()
const listeners = new Map<string, Set<Listener>>()

/** The current outline for a note path — a stable reference until the next publish. */
export function getOutline(path: string): readonly Heading[] {
  return outlines.get(path) ?? EMPTY
}

/** Subscribe to outline changes for a path; returns an unsubscribe function. */
export function subscribeOutline(path: string, listener: Listener): () => void {
  let set = listeners.get(path)
  if (set === undefined) {
    set = new Set<Listener>()
    listeners.set(path, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(path)
    if (current === undefined) {
      return
    }
    current.delete(listener)
    if (current.size === 0) {
      listeners.delete(path)
    }
  }
}

function emit(path: string): void {
  listeners.get(path)?.forEach((listener) => {
    listener()
  })
}

/** Replace the outline for a path and notify its subscribers. */
export function publishOutline(path: string, headings: readonly Heading[]): void {
  outlines.set(path, headings)
  emit(path)
}

/** Parse `markdown` for `path` and publish its headings. */
export function publishOutlineFromMarkdown(path: string, markdown: string): void {
  publishOutline(path, parseNote({ path, source: markdown }).headings)
}

/** Drop a path's outline (note unmount); notifies only if one existed. */
export function clearOutline(path: string): void {
  if (outlines.delete(path)) {
    emit(path)
  }
}
