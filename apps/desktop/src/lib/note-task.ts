import { readNote, TaskStaleError, toggleTaskMarker, writeNote } from '@reflect/core'
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
 * Toggle an open task's checkbox from the Tasks view (Plan 18) and persist it.
 *
 * A note open with **unsaved** edits is toggled through its live session, so
 * those edits survive and our write never parks a conflict. Every other case —
 * the note isn't open, or it's open but clean — takes the byte-exact disk path
 * (only the three marker characters change); an open clean session then
 * reconciles the change through the watcher. A stale or ambiguous index
 * surfaces as {@link TaskStaleError} rather than a silent wrong write, so the
 * caller can refuse loudly and let the reindex recover.
 */
export async function completeTask(task: TaskRef, generation: number): Promise<void> {
  const marker = { markerOffset: task.markerOffset, raw: task.raw }
  const owner = openSession(task.notePath)
  if (owner !== null && owner.isDirty()) {
    if (await owner.commitTaskToggle(marker)) {
      return
    }
    // Open and dirty, but the session declined (protected/conflict): a disk
    // write could clobber the buffer, so refuse and let the caller retry.
    throw new TaskStaleError('This note is being edited — save it, then try again.')
  }
  const source = await readNote(task.notePath)
  const next = toggleTaskMarker(source, marker)
  await writeNote(task.notePath, next.source, generation)
}
