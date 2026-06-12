import { tool, type TypedToolCall, type TypedToolResult } from 'ai'
import { z } from 'zod'
import { isAppError } from '../../errors'
import { readNote } from '../../graph/commands'
import { retrieve, type RetrievalHit, type RetrieveOptions } from '../../embeddings/retrieve'
import { parseFrontmatter, splitFrontmatter } from '../../markdown/frontmatter'
import { parseNote } from '../../markdown/extract'
import {
  cloudSafeNoteContent,
  cloudSafeSearchHits,
  isPrivateNoteError,
  type CloudNoteContent,
  type CloudSafe,
  type CloudSearchHit,
} from '../checkers'

/**
 * The read-only note tools the chat model can call (Plan 10, first wave),
 * and — deliberately in the same module — everything else that knows their
 * names: the {@link NoteToolCall}/{@link NoteToolResult} unions the engine
 * streams and the UI renders, and the mappers from SDK stream parts onto
 * them. Adding a tool means extending this file and the chip that renders
 * it; nothing else switches on tool names.
 *
 * Note content enters tool outputs only as {@link CloudSafe} values, minted
 * by the privacy gate in `../checkers` — search drops private hits entirely,
 * and reads re-check the live frontmatter before any content is minted.
 */

/** Default and ceiling for search hits per call (token budget, not recall). */
const DEFAULT_SEARCH_LIMIT = 8
const MAX_SEARCH_LIMIT = 20

/** Cap on returned note content so one huge note can't flood the context. */
export const MAX_NOTE_CONTENT_CHARS = 24_000

/** Injectable effects so tests can drive the tools without a live bridge. */
export interface NoteToolDeps {
  retrieveFn?: (query: string, options?: RetrieveOptions) => Promise<RetrievalHit[]>
  readNoteFn?: (path: string) => Promise<string>
}

export interface SearchNotesOutput {
  hits: CloudSafe<CloudSearchHit>[]
}

/** A successful read, or a structured refusal/miss the model can relay. */
export type ReadNoteOutput =
  | { ok: true; note: CloudSafe<CloudNoteContent> }
  | { ok: false; path: string; error: string }

const searchNotesInput = z.object({
  query: z.string().min(1).describe('Full-text search query over the note graph'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .describe(`How many notes to return (default ${DEFAULT_SEARCH_LIMIT})`),
})

const readNoteInput = z.object({
  path: z.string().min(1).describe('Graph-relative note path, e.g. notes/abc.md'),
})

/**
 * Build the chat tool set. `deps` is a test seam; production callers omit it
 * and the tools run over the shared retrieval layer and the live filesystem.
 */
export function buildNoteTools(deps: NoteToolDeps = {}) {
  const retrieveFn = deps.retrieveFn ?? retrieve
  const readNoteFn = deps.readNoteFn ?? readNote

  // The gate's live privacy probe: the index flag on a hit can lag a
  // just-saved `private: true`, so each candidate's frontmatter is re-read
  // from disk. Fail closed — a note that can't be read can't be cleared
  // for sending.
  const isPrivateLive = async (path: string): Promise<boolean> => {
    try {
      const { raw } = splitFrontmatter(await readNoteFn(path))
      return parseFrontmatter(raw).data.private
    } catch {
      return true
    }
  }

  return {
    search_notes: tool({
      description:
        'Search the user’s notes by meaning and keywords. Returns the best-matching ' +
        'notes with short snippets. Private notes are excluded.',
      inputSchema: searchNotesInput,
      execute: async ({ query, limit }): Promise<SearchNotesOutput> => {
        const hits = await retrieveFn(query, {
          limit: limit ?? DEFAULT_SEARCH_LIMIT,
          excludePrivateContent: true,
        })
        return { hits: await cloudSafeSearchHits(hits, isPrivateLive) }
      },
    }),

    read_note: tool({
      description:
        'Read the full markdown content of one note by its graph-relative path ' +
        '(from search_notes results). Private notes cannot be read.',
      inputSchema: readNoteInput,
      execute: async ({ path }): Promise<ReadNoteOutput> => {
        let source: string
        try {
          source = await readNoteFn(path)
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
      },
    }),
  }
}

/** The tool set type, for typed stream parts in the chat engine. */
export type NoteTools = ReturnType<typeof buildNoteTools>

/** The hit slice tool-activity UI renders (full hits stay engine-side). */
export type NoteHitSummary = Pick<CloudSearchHit, 'path' | 'title'>

/** One tool invocation, as the transcript sees it. */
export type NoteToolCall =
  | { tool: 'search'; toolCallId: string; query: string }
  | { tool: 'read'; toolCallId: string; path: string }

/** One settled tool invocation. A failed read keeps its refusal. */
export type NoteToolResult =
  | { tool: 'search'; toolCallId: string; query: string; hits: NoteHitSummary[] }
  | { tool: 'read'; toolCallId: string; path: string; title: string | null; error: string | null }

/** Map an SDK tool-call part onto {@link NoteToolCall} (null for dynamic). */
export function noteToolCall(part: TypedToolCall<NoteTools>): NoteToolCall | null {
  if (part.dynamic) {
    return null
  }
  return part.toolName === 'search_notes'
    ? { tool: 'search', toolCallId: part.toolCallId, query: part.input.query }
    : { tool: 'read', toolCallId: part.toolCallId, path: part.input.path }
}

/** Map an SDK tool-result part onto {@link NoteToolResult} (null for dynamic). */
export function noteToolResult(part: TypedToolResult<NoteTools>): NoteToolResult | null {
  if (part.dynamic) {
    return null
  }
  if (part.toolName === 'search_notes') {
    return {
      tool: 'search',
      toolCallId: part.toolCallId,
      query: part.input.query,
      hits: part.output.hits.map((hit) => ({ path: hit.path, title: hit.title })),
    }
  }
  const output = part.output
  return output.ok
    ? { tool: 'read', toolCallId: part.toolCallId, path: output.note.path, title: output.note.title, error: null }
    : { tool: 'read', toolCallId: part.toolCallId, path: output.path, title: null, error: output.error }
}
