import { readNote, toggleTaskMarker, writeNote } from '@reflect/core'
import { openSession } from '@/editor/open-documents'

/** The coordinates the Tasks view carries for a guarded checkbox write-back. */
export interface TaskRef {
  notePath: string
  /** Character offset of the marker's `[` in the file (UTF-16 units). */
  markerOffset: number
  /** The marker line verbatim — the staleness guard / relocation key. */
  raw: string
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
 * A note open with **unsaved** edits is toggled through its live session, so
 * those edits survive and our write never parks a conflict. Every other case —
 * the note isn't open, or it's open but clean — takes the byte-exact disk path
 * (only the three marker characters change); an open clean session then
 * reconciles through the watcher. A stale or ambiguous index surfaces as
 * `TaskStaleError` (from {@link toggleTaskMarker}) rather than a silent wrong
 * write; an unsaveable dirty note surfaces as {@link NoteBusyError}.
 */
export async function toggleTask(task: TaskRef, generation: number): Promise<void> {
  const marker = { markerOffset: task.markerOffset, raw: task.raw }
  const owner = openSession(task.notePath)
  if (owner !== null && owner.isDirty()) {
    if (await owner.commitTaskToggle(marker)) {
      return
    }
    throw new NoteBusyError(
      'This note has unsaved edits that can’t be saved right now — resolve it, then try again.',
    )
  }
  const source = await readNote(task.notePath)
  const next = toggleTaskMarker(source, marker)
  await writeNote(task.notePath, next.source, generation)
}
