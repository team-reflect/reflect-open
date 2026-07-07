import { tool, type TypedToolCall, type TypedToolResult } from 'ai'
import { z } from 'zod'
import { readNote } from '../../graph/commands'
import { retrieve, type RetrievalHit, type RetrieveOptions } from '../../embeddings/retrieve'
import { assetReferencingNotePaths } from '../../indexing/asset-refs'
import { listDailyNotes, type DailyNoteRow, type DailyNotesRange } from '../../indexing/queries'
import { listRecentNotes, type RecentNoteRow, type RecentNotesOptions } from '../../indexing/note-list'
import { parseFrontmatter, splitFrontmatter } from '../../markdown/frontmatter'
import { isTagName } from '../../markdown/extract'
import { buildReadOneAsset, readAssetsInput, type ReadAssetsOutput } from './read-assets'
import { buildReadOneNote, readNotesInput, type ReadNotesOutput } from './read-notes'
import {
  cloudSafeNoteListings,
  cloudSafeSearchHits,
  type CloudNoteListing,
  type CloudSafe,
  type CloudSearchHit,
  type CloudSendable,
} from '../checkers'

/**
 * The read-only note tools the chat model can call (Plan 10, first wave),
 * and — deliberately in the same module — everything else that knows their
 * names: the {@link NoteToolCall}/{@link NoteToolResult} unions the engine
 * streams and the UI renders, and the mappers from SDK stream parts onto
 * them. Adding a tool means registering it here (batch executors live in
 * sibling `read-*.ts` modules) and extending the chip that renders it;
 * nothing else switches on tool names.
 *
 * Note content enters tool outputs only as {@link CloudSafe} values, minted
 * by the privacy gate in `../checkers` — search drops private hits entirely,
 * and reads re-check the live frontmatter before any content is minted.
 */

/** Default and ceiling for search hits per call (token budget, not recall). */
const DEFAULT_SEARCH_LIMIT = 8
const MAX_SEARCH_LIMIT = 20

/** Default and ceiling for recent-note listings per call. */
const DEFAULT_RECENT_LIMIT = 10
const MAX_RECENT_LIMIT = 20

/** Most days one daily-range call returns; past it the model narrows the range. */
export const MAX_DAILY_NOTE_DAYS = 31

/** Injectable effects so tests can drive the tools without a live bridge. */
export interface NoteToolDeps {
  retrieveFn?: (query: string, options?: RetrieveOptions) => Promise<RetrievalHit[]>
  readNoteFn?: (path: string) => Promise<string>
  listRecentNotesFn?: (options: RecentNotesOptions) => Promise<RecentNoteRow[]>
  listDailyNotesFn?: (range: DailyNotesRange) => Promise<DailyNoteRow[]>
  assetReferencingNotePathsFn?: (assetPath: string) => Promise<string[]>
}

export interface BuildNoteToolsOptions extends NoteToolDeps {
  /**
   * Whether note search can use embeddings for meaning-based recall. When
   * false, `search_notes` stays lexical so disabled semantic search is honored.
   */
  semanticSearchEnabled?: boolean
}

export interface SearchNotesOutput {
  hits: CloudSafe<CloudSearchHit>[]
}

/**
 * A listing, or a corrective refusal for a `tag` the tag grammar can never
 * produce. Without the refusal a junk filter (`*`, `all`, whitespace…) reads
 * as a clean "0 notes" — indistinguishable from a real tag nothing carries —
 * and a model hunting for an "all notes" sentinel just keeps guessing.
 */
export type ListRecentNotesOutput =
  | { ok: true; notes: CloudSafe<CloudNoteListing>[] }
  | { ok: false; tag: string; error: string }

/** The refusal text — one string, read verbatim by both model and chip. */
export const INVALID_TAG_ERROR =
  'Not a tag — omit the tag to list all recent notes. Tags are single words like "book" or "project/atlas".'

export interface ListDailyNotesOutput {
  days: CloudSafe<CloudNoteListing>[]
  /** The range held more days than one call returns — narrow it to see the rest. */
  truncated: boolean
}

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

const listRecentNotesInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_RECENT_LIMIT)
    .optional()
    .describe(`How many notes to return (default ${DEFAULT_RECENT_LIMIT})`),
  tag: z
    .string()
    .nullish()
    .describe(
      'Only notes carrying this tag (case-insensitive, without the #). ' +
        'Omit, or pass null, to list all recent notes.',
    ),
})

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'an ISO date, YYYY-MM-DD')

const listDailyNotesInput = z.object({
  start: isoDate.describe('First day of the range, inclusive (YYYY-MM-DD)'),
  end: isoDate.describe('Last day of the range, inclusive (YYYY-MM-DD)'),
})

/** Shape one query row for the listings gate (epoch mtime → ISO timestamp). */
function listingCandidate(
  row: RecentNoteRow | DailyNoteRow,
): CloudSendable & Omit<CloudNoteListing, 'path'> {
  return {
    path: row.path,
    isPrivate: row.isPrivate,
    title: row.title,
    dailyDate: 'dailyDate' in row ? row.dailyDate : null,
    snippet: row.preview,
    modifiedAt: new Date(row.mtime).toISOString(),
  }
}

/**
 * Build the chat tool set. Optional effect overrides are a test seam;
 * production callers omit them and the tools run over the shared retrieval
 * layer and the live filesystem.
 */
export function buildNoteTools(options: BuildNoteToolsOptions = {}) {
  const retrieveFn = options.retrieveFn ?? retrieve
  const readNoteFn = options.readNoteFn ?? readNote
  const listRecentNotesFn = options.listRecentNotesFn ?? listRecentNotes
  const listDailyNotesFn = options.listDailyNotesFn ?? listDailyNotes
  const assetRefsFn = options.assetReferencingNotePathsFn ?? assetReferencingNotePaths
  const searchMode: RetrieveOptions['mode'] =
    options.semanticSearchEnabled === false ? 'lexical' : 'hybrid'

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

  const readOneNote = buildReadOneNote({ readNoteFn })

  const readOneAsset = buildReadOneAsset({
    readNoteFn,
    assetReferencingNotePathsFn: assetRefsFn,
  })

  return {
    search_notes: tool({
      description: searchNotesDescription(options.semanticSearchEnabled !== false),
      inputSchema: searchNotesInput,
      execute: async ({ query, limit }): Promise<SearchNotesOutput> => {
        const hits = await retrieveFn(query, {
          limit: limit ?? DEFAULT_SEARCH_LIMIT,
          mode: searchMode,
          excludePrivateContent: true,
        })
        return { hits: await cloudSafeSearchHits(hits, isPrivateLive) }
      },
    }),

    list_recent_notes: tool({
      description:
        'List the most recently edited notes, newest first — call it with no tag to see ' +
        'what the user wrote or worked on lately. Pass a tag only to narrow to notes ' +
        'carrying it. Daily notes are not included — use list_daily_notes for those. ' +
        'Private notes are excluded.',
      inputSchema: listRecentNotesInput,
      execute: async ({ limit, tag }): Promise<ListRecentNotesOutput> => {
        if (tag != null && !isTagName(tag)) {
          return { ok: false, tag, error: INVALID_TAG_ERROR }
        }
        const rows = await listRecentNotesFn({
          limit: limit ?? DEFAULT_RECENT_LIMIT,
          tag: tag ?? null,
        })
        return {
          ok: true,
          notes: await cloudSafeNoteListings(rows.map(listingCandidate), isPrivateLive),
        }
      },
    }),

    list_daily_notes: tool({
      description:
        'List the daily notes (the user’s journal, one note per day) in an inclusive date ' +
        'range, most recent first. Only days the user wrote on appear. Returns at most ' +
        `${MAX_DAILY_NOTE_DAYS} days — when truncated, narrow the range. ` +
        'Private notes are excluded.',
      inputSchema: listDailyNotesInput,
      execute: async ({ start, end }): Promise<ListDailyNotesOutput> => {
        const rows = await listDailyNotesFn({ start, end, limit: MAX_DAILY_NOTE_DAYS + 1 })
        const truncated = rows.length > MAX_DAILY_NOTE_DAYS
        const kept = truncated ? rows.slice(0, MAX_DAILY_NOTE_DAYS) : rows
        return {
          days: await cloudSafeNoteListings(kept.map(listingCandidate), isPrivateLive),
          truncated,
        }
      },
    }),

    read_notes: tool({
      description:
        'Read the full markdown content of one or more notes by their graph-relative ' +
        'paths (from search_notes results). Pass every note you need in a single call ' +
        'rather than reading them one at a time. Private notes cannot be read.',
      inputSchema: readNotesInput,
      execute: async ({ paths }): Promise<ReadNotesOutput> => {
        return { notes: await Promise.all(paths.map(readOneNote)) }
      },
    }),

    read_assets: tool({
      description:
        'Read the stored text description and OCR transcription of image or PDF ' +
        'attachments that notes embed as assets/… markdown links, e.g. ' +
        '![sketch](assets/sketch.png). Returns descriptive text about each file, not ' +
        'the file itself. Pass every attachment you need in a single call. ' +
        'Attachments of private notes cannot be read.',
      inputSchema: readAssetsInput,
      execute: async ({ paths }): Promise<ReadAssetsOutput> => {
        return { assets: await Promise.all(paths.map(readOneAsset)) }
      },
    }),
  }
}

/** Tool description for the active search mode. */
function searchNotesDescription(semanticSearchEnabled: boolean): string {
  const suffix =
    'Returns the best-matching notes with short snippets. Queries are plain language — there is no wildcard or operator syntax. Private notes are excluded.'
  if (semanticSearchEnabled) {
    return `Search the user’s notes by meaning and keywords. ${suffix}`
  }
  return `Search the user’s notes with lexical full-text search over titles and note bodies. ${suffix}`
}

/** The tool set type, for typed stream parts in the chat engine. */
export type NoteTools = ReturnType<typeof buildNoteTools>

/** The hit slice tool-activity UI renders (full hits stay engine-side). */
export type NoteHitSummary = Pick<CloudSearchHit, 'path' | 'title'>

/** One note's outcome in a read_notes call, for the tool-activity UI. */
export interface ReadNoteSummary {
  path: string
  title: string | null
  /** The per-note refusal/miss text, or `null` when the read succeeded. */
  error: string | null
}

/** One asset's outcome in a read_assets call, for the tool-activity UI. */
export interface ReadAssetSummary {
  path: string
  /** The per-asset refusal/miss text, or `null` when the read succeeded. */
  error: string | null
}

/** One tool invocation, as the transcript sees it. */
export type NoteToolCall =
  | { tool: 'search'; toolCallId: string; query: string }
  | { tool: 'read'; toolCallId: string; paths: string[] }
  | { tool: 'assets'; toolCallId: string; paths: string[] }
  | { tool: 'recents'; toolCallId: string; tag: string | null }
  | { tool: 'dailies'; toolCallId: string; start: string; end: string }

/** One settled tool invocation. A failed read or listing keeps its refusal. */
export type NoteToolResult =
  | { tool: 'search'; toolCallId: string; query: string; hits: NoteHitSummary[] }
  | { tool: 'read'; toolCallId: string; notes: ReadNoteSummary[] }
  | { tool: 'assets'; toolCallId: string; assets: ReadAssetSummary[] }
  | {
      tool: 'recents'
      toolCallId: string
      tag: string | null
      notes: NoteHitSummary[]
      error: string | null
    }
  | { tool: 'dailies'; toolCallId: string; start: string; end: string; days: NoteHitSummary[] }

/** Map an SDK tool-call part onto {@link NoteToolCall} (null for dynamic). */
export function noteToolCall(part: TypedToolCall<NoteTools>): NoteToolCall | null {
  if (part.dynamic) {
    return null
  }
  switch (part.toolName) {
    case 'search_notes':
      return { tool: 'search', toolCallId: part.toolCallId, query: part.input.query }
    case 'read_notes':
      return { tool: 'read', toolCallId: part.toolCallId, paths: part.input.paths }
    case 'read_assets':
      return { tool: 'assets', toolCallId: part.toolCallId, paths: part.input.paths }
    case 'list_recent_notes':
      return { tool: 'recents', toolCallId: part.toolCallId, tag: part.input.tag ?? null }
    case 'list_daily_notes':
      return {
        tool: 'dailies',
        toolCallId: part.toolCallId,
        start: part.input.start,
        end: part.input.end,
      }
  }
}

/** The path+title slice of one listing, for the tool-activity UI. */
function listingSummary(entry: CloudNoteListing): NoteHitSummary {
  return { path: entry.path, title: entry.title }
}

/** Map an SDK tool-result part onto {@link NoteToolResult} (null for dynamic). */
export function noteToolResult(part: TypedToolResult<NoteTools>): NoteToolResult | null {
  if (part.dynamic) {
    return null
  }
  switch (part.toolName) {
    case 'search_notes':
      return {
        tool: 'search',
        toolCallId: part.toolCallId,
        query: part.input.query,
        hits: part.output.hits.map((hit) => ({ path: hit.path, title: hit.title })),
      }
    case 'read_notes':
      return {
        tool: 'read',
        toolCallId: part.toolCallId,
        notes: part.output.notes.map((entry) =>
          entry.ok
            ? { path: entry.note.path, title: entry.note.title, error: null }
            : { path: entry.path, title: null, error: entry.error },
        ),
      }
    case 'read_assets':
      return {
        tool: 'assets',
        toolCallId: part.toolCallId,
        assets: part.output.assets.map((entry) =>
          entry.ok
            ? { path: entry.asset.path, error: null }
            : { path: entry.path, error: entry.error },
        ),
      }
    case 'list_recent_notes': {
      const output = part.output
      return output.ok
        ? {
            tool: 'recents',
            toolCallId: part.toolCallId,
            tag: part.input.tag ?? null,
            notes: output.notes.map(listingSummary),
            error: null,
          }
        : {
            tool: 'recents',
            toolCallId: part.toolCallId,
            tag: output.tag,
            notes: [],
            error: output.error,
          }
    }
    case 'list_daily_notes':
      return {
        tool: 'dailies',
        toolCallId: part.toolCallId,
        start: part.input.start,
        end: part.input.end,
        days: part.output.days.map(listingSummary),
      }
  }
}
