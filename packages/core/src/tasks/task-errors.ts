/**
 * Why an edit of a note was refused. `stale`: the addressed task is not in
 * the note. `notWritable`: the note cannot be rewritten faithfully, or its
 * open session cannot take an edit. `conflict`: the note changed on disk
 * during every attempt.
 */
export type NoteEditErrorKind = 'stale' | 'notWritable' | 'conflict'

/**
 * An edit of a note that was refused. Nothing was written.
 */
export class NoteEditError extends Error {
  readonly kind: NoteEditErrorKind

  constructor(kind: NoteEditErrorKind, message: string) {
    super(message)
    this.name = 'NoteEditError'
    this.kind = kind
  }
}
