import {
  appendTaskLine,
  editTaskLine,
  isAppError,
  readNote,
  removeTaskLine,
  taskLineToBullet,
  toggleTaskMarker,
  writeNote,
  type TaskMarker,
} from '@reflect/core'
import type { NoteSession } from '@/editor/note-session'
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
 * One pending-write chain per note path. Task writes read-modify-write a note,
 * so two firing at once on the same note (two checkbox clicks, a bulk delete
 * racing a checkbox) could each read the pre-write source and clobber. Routing
 * every write through the path's chain serializes them — the next only reads
 * after the previous has written. (The open-note path is already serialized by
 * the session's save chain; this closes the disk path and any open↔closed gap.)
 */
const writeChains = new Map<string, Promise<unknown>>()

function serializeByPath<T>(path: string, op: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(path) ?? Promise.resolve()
  // Run `op` whether the previous write resolved or rejected — one failure must
  // not wedge the chain for the note.
  const result = previous.then(op, op)
  const settled = result.then(
    () => {},
    () => {},
  )
  writeChains.set(path, settled)
  void settled.then(() => {
    // Drop the entry once the chain goes idle, so the map can't grow unbounded.
    if (writeChains.get(path) === settled) {
      writeChains.delete(path)
    }
  })
  return result
}

/**
 * Apply a Tasks-view change (toggle / edit / delete, Plan 18) and persist it,
 * routing the same way every time: when the note is **open**, through its live
 * session — which edits its in-memory buffer synchronously, so unsaved edits
 * survive and there's no read-then-write gap for a concurrent keystroke. The
 * session declines (and we refuse rather than clobber via disk) only when it
 * can't persist now (loading, protected/read-only, or a parked conflict),
 * surfaced as {@link NoteBusyError}. When the note is **not** open, disk is the
 * source of truth. A stale or ambiguous index surfaces as `TaskStaleError`
 * (from the core edit) rather than a silent wrong write.
 */
function applyTaskChange(
  task: TaskRef,
  generation: number,
  viaSession: (owner: NoteSession, marker: TaskMarker) => Promise<boolean>,
  viaDisk: (source: string, marker: TaskMarker) => string,
): Promise<void> {
  // Serialize per note: a concurrent change to the same note must not read the
  // pre-write source and clobber this one.
  return serializeByPath(task.notePath, async () => {
    // Pass only the marker coordinates onward — neither the session nor the disk
    // edit needs (or should depend on) the note path beyond locating the owner.
    const marker: TaskMarker = { markerOffset: task.markerOffset, raw: task.raw }
    const owner = openSession(task.notePath)
    if (owner !== null) {
      if (await viaSession(owner, marker)) {
        return
      }
      throw new NoteBusyError('This note can’t be updated right now — try again in a moment.')
    }
    const source = await readNote(task.notePath)
    await writeNote(task.notePath, viaDisk(source, marker), generation)
  })
}

/**
 * Toggle a task's checkbox from the Tasks view (Plan 18). The open-tasks view
 * only ever flips `[ ]`→`[x]`, but the primitive toggles, hence the name; the
 * disk path is byte-exact (only the three marker characters change).
 */
export function toggleTask(task: TaskRef, generation: number): Promise<void> {
  return applyTaskChange(
    task,
    generation,
    (owner, marker) => owner.commitTaskToggle(marker),
    (source, marker) => toggleTaskMarker(source, marker).source,
  )
}

/**
 * Replace a task's text from the inline Tasks editor (Plan 18), preserving its
 * marker (and so its checked state). `content` is one line of markdown.
 */
export function editTask(task: TaskRef, content: string, generation: number): Promise<void> {
  return applyTaskChange(
    task,
    generation,
    (owner, marker) => owner.commitTaskEdit(marker, content),
    (source, marker) => editTaskLine(source, marker, content),
  )
}

/** Delete a task's whole line from the Tasks view (Plan 18) — the ⌫/⌘⌫ path. */
export function deleteTask(task: TaskRef, generation: number): Promise<void> {
  return applyTaskChange(
    task,
    generation,
    (owner, marker) => owner.commitTaskRemove(marker),
    (source, marker) => removeTaskLine(source, marker),
  )
}

/**
 * Demote a task to a plain bullet from the Tasks view — "Convert to bullet"
 * (Plan 18 follow-up). Strips just the `[ ]`/`[x]` marker, keeping the bullet and
 * content, so the item drops out of the Tasks projection while staying in the
 * note. Routes session-or-disk and is guarded by the task's `raw` like its
 * siblings.
 */
export function convertTaskToBullet(task: TaskRef, generation: number): Promise<void> {
  return applyTaskChange(
    task,
    generation,
    (owner, marker) => owner.commitTaskToBullet(marker),
    (source, marker) => taskLineToBullet(source, marker),
  )
}

/**
 * Insert a new empty `+ [ ] ` task at the end of `notePath` (Plan 18's Return-to-
 * add) and return its marker offset, so the Tasks view can select the new row and
 * open its inline editor. A missing note — today's daily not yet created — starts
 * empty. Refuses an **open** note via {@link NoteBusyError}: appending through
 * disk would clobber its live buffer, and the Tasks view rarely targets one.
 * Serialized per path with the other task writes.
 */
export function insertTask(notePath: string, generation: number): Promise<number> {
  return serializeByPath(notePath, async () => {
    if (openSession(notePath) !== null) {
      throw new NoteBusyError('This note is open — add the task in the note itself.')
    }
    let source: string
    try {
      source = await readNote(notePath)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        source = '' // a not-yet-created daily note: the first task creates it
      } else {
        throw cause
      }
    }
    const { source: next, markerOffset } = appendTaskLine(source)
    await writeNote(notePath, next, generation)
    return markerOffset
  })
}
