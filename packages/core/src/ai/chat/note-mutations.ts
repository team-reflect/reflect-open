import { isAppError } from '../../errors'
import { isNotePath, isTemplatePath } from '../../graph/paths'
import { hashContent } from '../../indexing/hash'
import { appendBlock } from '../../markdown/append-section'
import { detectConflictMarkers } from '../../markdown/conflict-markers'
import { parseNote } from '../../markdown/extract'
import { splitFrontmatter } from '../../markdown/frontmatter'

/** A note mutation the chat model may request in a write-enabled turn. */
export type ChatNoteMutationKind = 'edit' | 'append'

/** Stable refusal codes returned to the model and rendered by the tool chip. */
export const NOTE_MUTATION_FAILURE_CODES = [
  'not_read',
  'invalid_path',
  'not_found',
  'private',
  'protected',
  'conflict',
  'stale',
  'missing',
  'ambiguous',
  'unavailable',
  'failed',
] as const

/** One provider-safe reason a requested note mutation was refused. */
export type NoteMutationFailureCode = (typeof NOTE_MUTATION_FAILURE_CODES)[number]

/** Lean provider-facing outcome; full before/after snapshots stay device-local. */
export type NoteMutationOutput =
  | {
      ok: true
      changeId: string
      path: string
      revision: string
      addedLines: number
      removedLines: number
    }
  | { ok: false; code: NoteMutationFailureCode; message: string }

/** One exact, body-only replacement requested by `edit_note`. */
export interface ExactNoteReplacement {
  oldText: string
  newText: string
}

/** Complete, guarded change handed to the desktop host for journaling and apply. */
export interface ApplyChatNoteChangeInput {
  kind: ChatNoteMutationKind
  toolCallId: string
  path: string
  title: string
  beforeSource: string
  afterSource: string
  expectedRevision: string
}

/** New-note request handed to the host, which owns collision-safe creation. */
export interface CreateChatNoteInput {
  toolCallId: string
  title: string
  body?: string | undefined
}

/**
 * Live note effects supplied by the app. Reads resolve the freshest editor
 * buffer when a note is open. Mutation methods must durably journal their
 * intended full-source change before applying it.
 */
export interface ChatNoteToolHost {
  readNote(path: string): Promise<string>
  applyChange(input: ApplyChatNoteChangeInput): Promise<NoteMutationOutput>
  createNote(input: CreateChatNoteInput): Promise<NoteMutationOutput>
}

/** A fully prepared body mutation, or a provider-safe structured refusal. */
export type PreparedChatNoteChange =
  | {
      ok: true
      path: string
      title: string
      beforeSource: string
      afterSource: string
      revision: string
    }
  | Extract<NoteMutationOutput, { ok: false }>

/**
 * Prepare exact replacements against the complete live source. Every anchor
 * must occur once in the original body and anchors may not overlap. The
 * frontmatter bytes are never part of the model-editable region.
 */
export async function prepareExactNoteEdit(input: {
  path: string
  expectedRevision: string
  replacements: readonly ExactNoteReplacement[]
  readNote: (path: string) => Promise<string>
}): Promise<PreparedChatNoteChange> {
  return await prepareBodyMutation(input.path, input.expectedRevision, input.readNote, (body) =>
    applyExactReplacements(body, input.replacements),
  )
}

/** Prepare a line-ending-preserving body append against the complete live source. */
export async function prepareNoteAppend(input: {
  path: string
  expectedRevision: string
  markdown: string
  readNote: (path: string) => Promise<string>
}): Promise<PreparedChatNoteChange> {
  return await prepareBodyMutation(input.path, input.expectedRevision, input.readNote, (body) => ({
    ok: true,
    body: appendBlock(body, input.markdown),
  }))
}

type BodyMutationResult = { ok: true; body: string } | Extract<NoteMutationOutput, { ok: false }>

async function prepareBodyMutation(
  path: string,
  expectedRevision: string,
  readNote: (path: string) => Promise<string>,
  mutateBody: (body: string) => BodyMutationResult,
): Promise<PreparedChatNoteChange> {
  if (!isNotePath(path) || isTemplatePath(path)) {
    return failure('invalid_path', 'This path is not an editable note.')
  }

  let beforeSource: string
  try {
    beforeSource = await readNote(path)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return failure('not_found', 'No note exists at this path.')
    }
    return failure('unavailable', 'The note is not available for editing.')
  }

  const beforeRevision = await hashContent(beforeSource)
  if (beforeRevision !== expectedRevision) {
    return failure('stale', 'The note changed. Read it again before editing.')
  }

  const beforeNote = parseNote({ path, source: beforeSource })
  if (beforeNote.frontmatter.private) {
    return failure('private', 'This note is private and cannot be edited by AI.')
  }
  if (detectConflictMarkers(beforeSource)) {
    return failure('conflict', 'Resolve this note’s sync conflict before editing it with AI.')
  }

  const split = splitFrontmatter(beforeSource)
  const mutation = mutateBody(split.body)
  if (!mutation.ok) {
    return mutation
  }
  const afterSource = beforeSource.slice(0, split.bodyOffset) + mutation.body
  const afterSplit = splitFrontmatter(afterSource)
  if (
    afterSplit.bodyOffset !== split.bodyOffset ||
    afterSource.slice(0, afterSplit.bodyOffset) !== beforeSource.slice(0, split.bodyOffset)
  ) {
    return failure('protected', 'AI edits cannot change note frontmatter.')
  }
  if (parseNote({ path, source: afterSource }).title !== beforeNote.title) {
    return failure('protected', 'AI edits cannot change a note’s title.')
  }

  return {
    ok: true,
    path,
    title: beforeNote.title,
    beforeSource,
    afterSource,
    revision: beforeRevision,
  }
}

/** Pure exact-anchor splice used by `edit_note` and its focused tests. */
export function applyExactReplacements(
  body: string,
  replacements: readonly ExactNoteReplacement[],
): BodyMutationResult {
  if (replacements.length === 0) {
    return failure('missing', 'At least one exact replacement is required.')
  }

  const located: Array<ExactNoteReplacement & { start: number; end: number }> = []
  for (const replacement of replacements) {
    if (replacement.oldText === '') {
      return failure('missing', 'Replacement anchors cannot be empty.')
    }
    if (replacement.oldText === body) {
      return failure(
        'protected',
        'Whole-note replacements are not allowed. Use smaller exact replacement anchors.',
      )
    }
    const occurrences = occurrenceOffsets(body, replacement.oldText)
    if (occurrences.length === 0) {
      return failure('missing', 'An exact replacement anchor was not found. Read the note again.')
    }
    if (occurrences.length > 1) {
      return failure('ambiguous', 'An exact replacement anchor appears more than once.')
    }
    const start = occurrences[0]!
    located.push({ ...replacement, start, end: start + replacement.oldText.length })
  }

  const ordered = [...located].sort((left, right) => left.start - right.start)
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
      return failure('ambiguous', 'Exact replacement anchors overlap.')
    }
  }

  let updated = body
  for (const replacement of ordered.toReversed()) {
    updated =
      updated.slice(0, replacement.start) + replacement.newText + updated.slice(replacement.end)
  }
  return { ok: true, body: updated }
}

function occurrenceOffsets(text: string, needle: string): number[] {
  const offsets: number[] = []
  let from = 0
  while (from <= text.length - needle.length) {
    const offset = text.indexOf(needle, from)
    if (offset === -1) {
      break
    }
    offsets.push(offset)
    from = offset + 1
  }
  return offsets
}

function failure(
  code: NoteMutationFailureCode,
  message: string,
): Extract<NoteMutationOutput, { ok: false }> {
  return { ok: false, code, message }
}
