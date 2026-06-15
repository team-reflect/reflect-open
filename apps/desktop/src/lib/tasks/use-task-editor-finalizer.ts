import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import { resolveTaskEdit } from '@/lib/tasks/task-content'

/** The finalizer commands a task editor's keymap binds to its keys. */
export interface TaskEditorApi {
  commit: () => void
  /**
   * Enter (V1 continuous entry): persist any change like {@link commit}, then ask
   * the screen to add the next task. Carries the resolved content — the new text
   * to save, `''` for an emptied row, or `null` when nothing changed.
   */
  commitAndContinue: () => void
  cancel: () => void
  /** ⌘↵: save any change, then complete the task (or delete it if emptied). */
  complete: () => void
  /** ⌘⌫: delete the task outright, discarding any pending edit. */
  delete: () => void
  /** Backspace on an empty row: delete it and select the previous task (V1). */
  deleteEmpty: () => void
  isEmpty: () => boolean
}

export interface TaskEditorFinalizerOptions {
  /** The content the editor was seeded with — the baseline a commit compares against. */
  initial: string
  /** Persist the new content (non-empty, changed) and exit edit mode. */
  onCommit: (content: string) => void
  /**
   * Enter (V1 continuous entry): persist the current edit then add the next task.
   * `content` is the new text (changed), `''` (emptied), or `null` (unchanged) —
   * the screen rewrites the row only when it isn't null before inserting below.
   */
  onContinue: (content: string | null) => void
  /** Delete the task (emptied via ⌘↵, or ⌘⌫) and exit edit mode. */
  onDelete: () => void
  /** Backspace on an empty row: delete it and select the previous task (V1). */
  onDeleteEmpty: () => void
  /** Exit edit mode without writing (Escape / unchanged). */
  onCancel: () => void
  /**
   * Complete the task and exit (⌘↵). `content` is the new text when the edit
   * changed it (save **and** complete), or `null` to complete the unchanged task.
   */
  onComplete: (content: string | null) => void
  /**
   * Persist a changed edit **without** exiting edit mode — the row is unmounting
   * because the selection already moved elsewhere, so it must not clear it.
   */
  onFlush: (content: string) => void
}

export interface TaskEditorFinalizer {
  /** Stable across renders; carries this render's finalizers to the bound keymap. */
  apiRef: MutableRefObject<TaskEditorApi>
  /** Feed every editor change so a commit sees the latest markdown. */
  onChange: (markdown: string) => void
}

/**
 * The inline task editor's commit/cancel/complete/delete state machine (Plan 18),
 * kept apart from the editor view so the finalizing rules are one cohesive,
 * testable unit.
 *
 * Finalizing is single-shot — the first finalizer to run `claim()`s the editor,
 * so the row unmounting afterward can't double-fire a write. Two kinds:
 *
 * - **Explicit exit** (the keymap): Enter commits; Escape cancels; ⌘↵ completes
 *   (saving the edit first when changed); ⌘⌫ deletes; empty + Backspace deletes.
 *   Each ends edit mode (the screen clears the sole selection).
 * - **Unmount flush**: when the selection has *already* moved off this row, the
 *   cleanup persists a changed edit via `onFlush` but never clears the selection
 *   (it's the new row's) and never cancels — an unchanged row is simply dropped.
 *
 * {@link resolveTaskEdit} turns the current text vs. the seed into
 * commit/cancel/delete, so a whitespace-only change never rewrites the file. The
 * commands are bound once via {@link TaskEditorFinalizer.apiRef} but always call
 * this render's callbacks — the keymap closes over the ref, not a stale closure.
 */
export function useTaskEditorFinalizer({
  initial,
  onCommit,
  onContinue,
  onDelete,
  onDeleteEmpty,
  onCancel,
  onComplete,
  onFlush,
}: TaskEditorFinalizerOptions): TaskEditorFinalizer {
  const currentRef = useRef(initial)
  const doneRef = useRef(false)

  // Bound once, but reassigned each render so the keymap's stable reference
  // always reaches this render's finalizers.
  const apiRef = useRef<TaskEditorApi>({
    commit: () => {},
    commitAndContinue: () => {},
    cancel: () => {},
    complete: () => {},
    delete: () => {},
    deleteEmpty: () => {},
    isEmpty: () => false,
  })
  const claim = (): boolean => {
    if (doneRef.current) {
      return false
    }
    doneRef.current = true
    return true
  }
  // Reassigned each render (like apiRef) so the unmount cleanup — registered once
  // — flushes against this render's `initial`/`onFlush`, not the mount-time ones.
  const flushRef = useRef<() => void>(() => {})
  flushRef.current = (): void => {
    if (doneRef.current) {
      return
    }
    // Selection already moved → persist a real change (or the cleared line as an
    // empty task) without touching the selection or the cancel/exit path. An
    // unchanged editor claims nothing — so a StrictMode double-cleanup can't
    // starve a later explicit commit/cancel of the single-shot claim.
    const result = resolveTaskEdit(initial, currentRef.current)
    if (result.type === 'cancel') {
      return
    }
    doneRef.current = true
    onFlush(result.type === 'commit' ? result.content : '')
  }
  apiRef.current = {
    commit: () => {
      if (!claim()) {
        return
      }
      const result = resolveTaskEdit(initial, currentRef.current)
      if (result.type === 'commit') {
        onCommit(result.content)
      } else if (result.type === 'delete') {
        onDelete()
      } else {
        onCancel()
      }
    },
    commitAndContinue: () => {
      if (!claim()) {
        return
      }
      // Enter always adds the next task (V1). Hand the screen the resolved content
      // to persist first — the new text, `''` for an emptied row, or `null` when
      // unchanged (don't rewrite) — so the insert can sequence after the save.
      const result = resolveTaskEdit(initial, currentRef.current)
      onContinue(
        result.type === 'commit' ? result.content : result.type === 'delete' ? '' : null,
      )
    },
    cancel: () => {
      if (!claim()) {
        return
      }
      // An editor left empty on Escape — a Return-to-add row never typed into, or
      // a task whose text was cleared — removes the line rather than leaving a
      // blank task (V1). Decided on the *live* editor content, never the row's
      // (possibly stale) projected text: Escape discards the unsaved edit, so a
      // row with typed content is kept, not deleted.
      if (currentRef.current.trim() === '') {
        onDelete()
      } else {
        onCancel()
      }
    },
    complete: () => {
      if (!claim()) {
        return
      }
      // Emptying then completing means delete (an empty task can't be "done");
      // an unchanged task just toggles; otherwise save the new text and complete.
      const result = resolveTaskEdit(initial, currentRef.current)
      if (result.type === 'delete') {
        onDelete()
      } else if (result.type === 'commit') {
        onComplete(result.content)
      } else {
        onComplete(null)
      }
    },
    delete: () => {
      if (claim()) {
        onDelete()
      }
    },
    deleteEmpty: () => {
      if (claim()) {
        onDeleteEmpty()
      }
    },
    isEmpty: () => currentRef.current.trim() === '',
  }

  // Persist a pending edit when the row unmounts — the selection moved off it, so
  // flush (never clear/cancel) keeps the now-current selection intact.
  useEffect(() => () => flushRef.current(), [])

  const onChange = useCallback((markdown: string) => {
    currentRef.current = markdown
  }, [])

  return { apiRef, onChange }
}
