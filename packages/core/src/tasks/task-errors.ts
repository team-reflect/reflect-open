/** The task a caller addressed is not in the note anymore: the write is refused. */
export class TaskStaleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskStaleError'
  }
}

/** The note cannot be rewritten through the AST without changing its content. */
export class NoteNotSerializableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoteNotSerializableError'
  }
}

/**
 * A note couldn't be written because it is open with unsaved edits that
 * the session can't persist right now: it's read-only/protected or disposed.
 * Distinct from `TaskStaleError` (a stale index): the
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
 * A note changed on disk during every attempt to commit an edit to it.
 * Nothing was written.
 */
export class NoteConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoteConflictError'
  }
}
