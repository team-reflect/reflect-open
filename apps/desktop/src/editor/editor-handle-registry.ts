import type { NoteEditorHandle } from '@/editor/note-editor'

/**
 * The mounted note editors, keyed by graph-relative note path. Commands that
 * act on "the current note's editor" (Attach file…) resolve the handle for
 * `CommandContext.notePath()` here — the same path the context sidebar and
 * note-scoped commands target, so an insertion can never land in a different
 * note than the one those commands describe.
 *
 * Module-level rather than a provider: registrations come from render-phase
 * ref callbacks and reads from command dispatch, neither of which needs
 * React state or re-renders (the same shape as `operations.ts`).
 */
const handles = new Map<string, NoteEditorHandle>()
const handleGenerations = new Map<string, number | null>()
let pendingHeadingReveal: {
  readonly generation: number | null
  readonly path: string
  readonly fragment: string
} | null = null

/** Make `handle` the editor for `path` (the pane's ref callback, on mount). */
export function registerNoteEditorHandle(
  path: string,
  handle: NoteEditorHandle,
  generation: number | null = null,
): void {
  handles.set(path, handle)
  handleGenerations.set(path, generation)
  if (
    pendingHeadingReveal?.path === path &&
    pendingHeadingReveal.generation === generation
  ) {
    const { fragment } = pendingHeadingReveal
    pendingHeadingReveal = null
    handle.revealHeading(fragment)
  }
}

/**
 * Remove `handle`'s registration (the pane's ref callback, on unmount). A
 * no-op when another editor has since registered the same path, so an
 * unmount racing a remount never drops the live handle.
 */
export function unregisterNoteEditorHandle(path: string, handle: NoteEditorHandle): void {
  if (handles.get(path) === handle) {
    handles.delete(path)
    handleGenerations.delete(path)
  }
}

/** The mounted editor for a note path, or null when none is on screen. */
export function noteEditorHandleFor(path: string): NoteEditorHandle | null {
  return handles.get(path) ?? null
}

/**
 * Reveal `fragment` in a mounted note, or retain it until that note's editor
 * registers during in-window navigation. The request is consumed exactly once.
 */
export function requestNoteHeadingReveal(
  path: string,
  fragment: string,
  generation: number | null = null,
): boolean {
  const handle = noteEditorHandleFor(path)
  if (handle !== null && handleGenerations.get(path) === generation) {
    pendingHeadingReveal = null
    return handle.revealHeading(fragment)
  }
  pendingHeadingReveal = { generation, path, fragment }
  return false
}
