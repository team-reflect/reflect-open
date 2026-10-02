import {
  applyTaskEdits,
  isAppError,
  readNote,
  writeNote,
  type TaskEdit,
  type TaskEditResult,
  type TaskLocator,
  type TaskSnapshot,
} from '@reflect/core'
import { openSession } from '@/editor/open-documents.ts'

/** A task's locator ({@link TaskLocator}) plus the note it lives in. */
export interface TaskRef extends TaskLocator {
  notePath: string
}

export interface ContinuedTaskInContext {
  /** The new empty task, as the written note addresses it. */
  readonly created: TaskSnapshot
  /** Where every pre-existing task of the note ended up after the write. */
  readonly moved: TaskEditResult['moved']
}

/**
 * A task couldn't be written because its note is open with unsaved edits that
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

interface WriteTaskEditsOptions {
  /** Treat a missing note as empty: the first task creates it (today's daily). */
  readonly createIfMissing?: boolean
}

async function readSource(notePath: string, createIfMissing: boolean): Promise<string> {
  try {
    return await readNote(notePath)
  } catch (cause) {
    if (createIfMissing && isAppError(cause) && cause.kind === 'notFound') {
      return ''
    }
    throw cause
  }
}

/**
 * Apply Tasks-view edits (Plan 18) to one note and persist them, routing the
 * same way every time: when the note is **open**, through its live session,
 * which transforms its in-memory buffer synchronously, so unsaved edits survive
 * and there's no read-then-write gap for a concurrent keystroke. The session
 * declines (and we refuse rather than clobber via disk) only when it can't
 * persist now (loading, protected/read-only, or a parked conflict), surfaced as
 * {@link NoteBusyError}. When the note is **not** open, disk is the source of
 * truth. Every locator in `edits` describes the note as the index last saw it;
 * one whose task is gone surfaces as `TaskStaleError` from the core edit
 * rather than a silent wrong write. The result reports where every task of
 * the note ended up, so callers can re-address cached rows before the reindex.
 */
export function writeTaskEdits(
  notePath: string,
  edits: readonly TaskEdit[],
  generation: number,
  options: WriteTaskEditsOptions = {},
): Promise<TaskEditResult> {
  // Serialize per note: a concurrent change to the same note must not read the
  // pre-write source and clobber this one.
  return serializeByPath(notePath, async (): Promise<TaskEditResult> => {
    const owner = openSession(notePath)
    if (owner !== null) {
      let result: TaskEditResult | undefined
      const applied = await owner.commitSourceEdit((source) => {
        result = applyTaskEdits(source, edits)
        return result.source
      })
      if (!applied || result === undefined) {
        throw new NoteBusyError('This note can’t be updated right now — try again in a moment.')
      }
      return result
    }
    const source = await readSource(notePath, options.createIfMissing === true)
    const result = applyTaskEdits(source, edits)
    await writeNote(notePath, result.source, generation)
    return result
  })
}

/** Only the locator goes to the core edit: the note path merely picks the owner. */
function toLocator(task: TaskRef): TaskLocator {
  return { astPath: task.astPath, markdown: task.markdown, checked: task.checked }
}

function requireInserted(result: TaskEditResult): TaskSnapshot {
  const created = result.inserted[0]
  if (created === undefined) {
    throw new Error('The new task was not written.')
  }
  return created
}

/**
 * Toggle a task's checkbox from the Tasks view (Plan 18). The open-tasks view
 * only ever flips `[ ]`→`[x]`, but the primitive toggles, hence the name.
 */
export function toggleTask(task: TaskRef, generation: number): Promise<TaskEditResult> {
  return writeTaskEdits(task.notePath, [{ kind: 'toggle', task: toLocator(task) }], generation)
}

/**
 * Replace a task's Markdown from the inline Tasks editor (Plan 18), keeping its
 * checked state. `markdown` is the task's first paragraph without the marker.
 */
export function editTask(
  task: TaskRef,
  markdown: string,
  generation: number,
): Promise<TaskEditResult> {
  return writeTaskEdits(
    task.notePath,
    [{ kind: 'setMarkdown', task: toLocator(task), markdown }],
    generation,
  )
}

/** Delete a task from the Tasks view (Plan 18), the ⌫/⌘⌫ path. Nested items move up. */
export function deleteTask(task: TaskRef, generation: number): Promise<TaskEditResult> {
  return writeTaskEdits(task.notePath, [{ kind: 'remove', task: toLocator(task) }], generation)
}

/**
 * Demote a task to a plain bullet from the Tasks view — "Convert to bullet"
 * (Plan 18 follow-up). Drops just the checkbox, keeping the bullet and its
 * content, so the item leaves the Tasks projection while staying in the note.
 */
export function convertTaskToBullet(task: TaskRef, generation: number): Promise<TaskEditResult> {
  return writeTaskEdits(task.notePath, [{ kind: 'toBullet', task: toLocator(task) }], generation)
}

/**
 * Save an inline edit and toggle the task's checkbox in one write. Both edits
 * address the task as the index knew it; the batch resolves them before it
 * changes anything, so the toggle lands on the rewritten task.
 */
export function editAndToggleTask(
  task: TaskRef,
  markdown: string,
  generation: number,
): Promise<TaskEditResult> {
  const locator = toLocator(task)
  return writeTaskEdits(
    task.notePath,
    [
      { kind: 'setMarkdown', task: locator, markdown },
      { kind: 'toggle', task: locator },
    ],
    generation,
  )
}

/** Save an inline edit and convert the task to a bullet in one write. */
export function editAndConvertTaskToBullet(
  task: TaskRef,
  markdown: string,
  generation: number,
): Promise<TaskEditResult> {
  const locator = toLocator(task)
  return writeTaskEdits(
    task.notePath,
    [
      { kind: 'setMarkdown', task: locator, markdown },
      { kind: 'toBullet', task: locator },
    ],
    generation,
  )
}

/**
 * Continue entry from a grouped task: resolve the current draft and add a new
 * empty task at the end of the same parent item, in one write. Changed content
 * replaces the anchor's Markdown; cleared content removes the anchor. The
 * result addresses the new row and every moved row in the written note, so the
 * Tasks view can select the new task and re-key cached rows before reindexing
 * catches up.
 */
export async function continueTaskInContext(
  task: TaskRef,
  content: string | null,
  generation: number,
): Promise<ContinuedTaskInContext> {
  const locator = toLocator(task)
  const edits: TaskEdit[] = [
    { kind: 'insert', at: { kind: 'contextEnd', task: locator }, markdown: '' },
  ]
  if (content === '') {
    edits.push({ kind: 'remove', task: locator })
  } else if (content !== null) {
    edits.push({ kind: 'setMarkdown', task: locator, markdown: content })
  }
  const result = await writeTaskEdits(task.notePath, edits, generation)
  return { created: requireInserted(result), moved: result.moved }
}

/**
 * Insert a new empty `+ [ ]` task at the end of `notePath` (Plan 18's Return-
 * to-add) and return its address, so the Tasks view can select the new row and
 * open its inline editor. A missing note (today's daily not yet created)
 * starts empty.
 */
export async function insertTask(notePath: string, generation: number): Promise<TaskSnapshot> {
  const result = await writeTaskEdits(
    notePath,
    [{ kind: 'insert', at: { kind: 'documentEnd' }, markdown: '' }],
    generation,
    { createIfMissing: true },
  )
  return requireInserted(result)
}
