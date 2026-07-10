import type { EditorHandle } from '@meowdown/react'

interface FlushableDomObserver {
  forceFlush?(): void
  flush(): void
}

/**
 * Does `value` look like ProseMirror's private `DOMObserver`? Exported only
 * for the rot-detection test that mounts the real editor: when a meowdown or
 * ProseMirror upgrade changes this internal shape, the barrier degrades to a
 * no-op by design — the test turns that silent degradation into a CI failure.
 */
export function isFlushableDomObserver(value: unknown): value is FlushableDomObserver {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const forceFlush: unknown = Reflect.get(value, 'forceFlush')
  return (
    typeof Reflect.get(value, 'flush') === 'function' &&
    (forceFlush === undefined || typeof forceFlush === 'function')
  )
}

/**
 * Synchronize the editor state with pending native DOM mutations.
 *
 * ProseMirror 1.42 deliberately delays mutation records captured during blur
 * by 20ms. Its observer is not part of the typed public API, so this narrow
 * reflective boundary keeps the dependency reach-in isolated and degrades to
 * a no-op if the implementation changes. Meowdown owns the long-term API;
 * Reflect still needs a synchronous persistence barrier in the meantime.
 */
function flushPendingEditorDom(handle: EditorHandle | null): boolean {
  const editor = handle?.editor
  if (editor === undefined || editor.view.isDestroyed) {
    return false
  }
  const previous = editor.state.doc
  const observer: unknown = Reflect.get(editor.view, 'domObserver')
  if (!isFlushableDomObserver(observer)) {
    return false
  }
  // `flushSoon()` blocks a plain `flush()` until its 20ms timer fires, while
  // `stop()` (the blur path) queues records behind a different untracked
  // timer. `forceFlush()` handles the former; the following `flush()` drains
  // the latter. Calling both is therefore intentional.
  observer.forceFlush?.()
  observer.flush()
  return !editor.state.doc.eq(previous)
}

/**
 * Flush pending native input, then serialize the editor's settled document.
 *
 * This runs on every serialization — including the per-change callback, not
 * just persistence flushes — deliberately: a doc change dispatched while a
 * composition's mutation records sit in the delayed queue would otherwise
 * hand the session a buffer missing the composed text, and the debounced
 * save can persist that stale buffer before the 20ms timer corrects it.
 * Re-entry from inside a dispatch is safe: a second flush finds no pending
 * records and stops (verified against WebKit in the Meowdown 0.42 harness).
 */
export function settledEditorMarkdown(handle: EditorHandle | null): string {
  flushPendingEditorDom(handle)
  return handle?.getMarkdown() ?? ''
}

/** Return the settled document only when flushing native input changed it. */
export function commitPendingEditorInput(handle: EditorHandle | null): string | null {
  return flushPendingEditorDom(handle) ? (handle?.getMarkdown() ?? '') : null
}
