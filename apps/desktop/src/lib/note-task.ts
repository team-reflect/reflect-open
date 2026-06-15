import { readNote, toggleTaskMarker, writeNote, type TaskMarker } from '@reflect/core'
import { openSession } from '@/editor/open-documents'

/** The marker coordinates ({@link TaskMarker}) plus the note they live in. */
export interface TaskRef extends TaskMarker {
  notePath: string
}

/**
 * A task couldn't be toggled because its note is open with unsaved edits that
 * the session can't persist right now — it's read-only/protected, or a sync
 * conflict is parked. Distinct from `TaskStaleError` (a stale index): the
 * recovery is "save or resolve the note", not "reindex". We refuse rather than
 * write to disk, which would clobber the live buffer.
 */
export class NoteBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoteBusyError'
  }
}

/**
 * Toggle a task's checkbox from the Tasks view (Plan 18) and persist it. The
 * open-tasks view only ever flips `[ ]`→`[x]`, but the primitive toggles, hence
 * the name.
 *
 * When the note is **open**, the toggle goes through its live session: the
 * session toggles its own in-memory buffer synchronously, so any unsaved edits
 * are preserved and there is no read-then-write gap for a concurrent keystroke
 * to slip into. It declines — and we refuse rather than clobber via disk — only
 * when it can't persist right now (still loading, protected/read-only, or a
 * parked sync conflict), surfaced as {@link NoteBusyError}. When the note is
 * **not** open, disk is the source of truth and the toggle is byte-exact (only
 * the three marker characters change). A stale or ambiguous index surfaces as
 * `TaskStaleError` (from {@link toggleTaskMarker}) rather than a silent wrong write.
 */
export async function toggleTask(task: TaskRef, generation: number): Promise<void> {
  // Pass only the marker coordinates onward — neither the session nor the disk
  // toggle needs (or should depend on) the note path beyond locating the owner.
  const marker: TaskMarker = { markerOffset: task.markerOffset, raw: task.raw }
  const owner = openSession(task.notePath)
  if (owner !== null) {
    if (await owner.commitTaskToggle(marker)) {
      return
    }
    throw new NoteBusyError('This note can’t be updated right now — try again in a moment.')
  }
  const source = await readNote(task.notePath)
  const next = toggleTaskMarker(source, marker)
  await writeNote(task.notePath, next.source, generation)
}
