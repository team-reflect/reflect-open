import { z } from 'zod'
import { isAppError } from '../../errors'
import { parseNote } from '../../markdown/extract'
import { splitFrontmatter } from '../../markdown/frontmatter'
import {
  cloudSafeNoteContent,
  isPrivateNoteError,
  type CloudNoteContent,
  type CloudSafe,
} from '../checkers'

/**
 * The read_notes tool's executor (Plan 10): resolve a graph-relative note
 * path to its body and gate it for the provider. The tool registration,
 * name, and transcript unions stay in `./tools` — this module only knows how
 * to read one note.
 */

/** Cap on returned note content so one huge note can't flood the context. */
export const MAX_NOTE_CONTENT_CHARS = 24_000

/**
 * Cap on notes one read_notes call returns. Each note is itself capped at
 * {@link MAX_NOTE_CONTENT_CHARS}, so this bounds a single batch read to roughly
 * the per-turn token reserve — past it the model splits the read across calls.
 */
export const MAX_READ_NOTES = 10

/** One note in a {@link ReadNotesOutput}: its content, or a structured refusal/miss. */
export type ReadNoteResult =
  | { ok: true; note: CloudSafe<CloudNoteContent> }
  | { ok: false; path: string; error: string }

/** The read_notes output: one {@link ReadNoteResult} per requested path, in order. */
export interface ReadNotesOutput {
  notes: ReadNoteResult[]
}

export const readNotesInput = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_READ_NOTES)
    .describe(
      'Graph-relative note paths to read, e.g. ["notes/abc.md"] (from search_notes ' +
        `results). Pass every note you need in one call, up to ${MAX_READ_NOTES}.`,
    ),
})

/** The effects {@link buildReadOneNote} needs, already defaulted by the caller. */
export interface ReadNoteDeps {
  readNoteFn: (path: string) => Promise<string>
}

/**
 * Build the per-note reader for read_notes: the body (frontmatter stripped,
 * capped), or a structured per-note miss/refusal so one bad path never fails
 * the batch. Content is minted CloudSafe only after the live private re-check.
 */
export function buildReadOneNote(deps: ReadNoteDeps) {
  return async function readOneNote(path: string): Promise<ReadNoteResult> {
    let source: string
    try {
      source = await deps.readNoteFn(path)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        return { ok: false, path, error: 'No note exists at this path.' }
      }
      throw cause
    }
    const parsed = parseNote({ path, source })
    const { body } = splitFrontmatter(source)
    const truncated = body.length > MAX_NOTE_CONTENT_CHARS
    try {
      return {
        ok: true,
        note: cloudSafeNoteContent({
          path,
          isPrivate: parsed.frontmatter.private,
          title: parsed.title,
          content: truncated ? body.slice(0, MAX_NOTE_CONTENT_CHARS) : body,
          truncated,
        }),
      }
    } catch (cause) {
      if (isPrivateNoteError(cause)) {
        return { ok: false, path, error: 'This note is marked private and cannot be read by AI.' }
      }
      throw cause
    }
  }
}
