import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely'
import type { Database } from '@reflect/db'
import { db } from './db'
import { previewSnippet } from './snippet'

/**
 * The All Notes list: every non-daily note, newest first, optionally narrowed
 * to one tag. Daily notes are excluded by design — the stream is their home —
 * which mirrors the original app's notes list (`isDaily = 0` there,
 * `daily_date IS NULL` here). Uncapped: the screen virtualizes, and neither
 * query carries a per-row parameter, so list size has no SQL ceiling.
 */

/** One row of the All Notes list. */
export interface NoteListEntry {
  path: string
  title: string
  /** First body line after the title, trimmed for the row (may be empty). */
  snippet: string
  /** The note's body tags (first-seen casing), alphabetical. */
  tags: string[]
  /** File modification time (epoch ms) — the list's recency sort key. */
  mtime: number
}

export interface NoteListOptions {
  /** Only notes carrying this tag (case-insensitive). `null` lists all. */
  tag?: string | null
}

// Enough of the plain text to find the first body line under any sane title,
// without shipping whole notes over IPC for every row.
const SNIPPET_SOURCE_CHARS = 600

/**
 * EXISTS predicate: the candidate `notes` row carries `tag`, case-insensitive
 * (the same collation as the `#tag` search token). Shared by the note and
 * per-note-tag queries so the two can't disagree about what "filtered" means.
 */
function noteCarriesTag(tag: string) {
  const folded = tag.toLowerCase()
  return (eb: ExpressionBuilder<Database, 'notes'>): Expression<SqlBool> =>
    eb.exists(
      eb
        .selectFrom('tags')
        .select(sql<number>`1`.as('one'))
        .whereRef('tags.notePath', '=', 'notes.path')
        .where(sql<string>`lower(tags.tag)`, '=', folded),
    )
}

/** Non-daily notes for the All Notes screen, most recently edited first. */
export async function listNotes(options: NoteListOptions = {}): Promise<NoteListEntry[]> {
  const tag = options.tag ?? null

  let query = db
    .selectFrom('notes')
    .leftJoin('noteText', 'noteText.notePath', 'notes.path')
    .where('notes.dailyDate', 'is', null)
    .select([
      'notes.path',
      'notes.title',
      'notes.mtime',
      sql<string | null>`substr(note_text.text, 1, ${SNIPPET_SOURCE_CHARS})`.as('textHead'),
    ])
    .orderBy('notes.mtime', 'desc')
    .orderBy('notes.path')
  if (tag !== null) {
    query = query.where(noteCarriesTag(tag))
  }

  const rows = await query.execute()
  if (rows.length === 0) {
    return []
  }

  // Tags for the same note set, via the same predicates — a join rather than a
  // `note_path IN (…)` list, which would put a per-row parameter between the
  // list and SQLite's bound-parameter ceiling.
  let tagQuery = db
    .selectFrom('tags')
    .innerJoin('notes', 'notes.path', 'tags.notePath')
    .where('notes.dailyDate', 'is', null)
    .select(['tags.notePath', 'tags.tag'])
    .orderBy('tags.tag')
  if (tag !== null) {
    tagQuery = tagQuery.where(noteCarriesTag(tag))
  }
  const tagRows = await tagQuery.execute()
  const tagsByPath = new Map<string, string[]>()
  for (const row of tagRows) {
    const tags = tagsByPath.get(row.notePath)
    if (tags === undefined) {
      tagsByPath.set(row.notePath, [row.tag])
    } else {
      tags.push(row.tag)
    }
  }

  return rows.map((row) => ({
    path: row.path,
    title: row.title,
    mtime: row.mtime,
    snippet: previewSnippet(row.textHead ?? '', row.title),
    tags: tagsByPath.get(row.path) ?? [],
  }))
}

/** One tag facet over the note list: display casing + non-daily note count. */
export interface NoteTagFacet {
  tag: string
  count: number
}

/**
 * Every tag carried by at least one non-daily note, with how many such notes
 * carry it, alphabetical. Case-insensitive collation matches the tag filter
 * (and the `#tag` search token): `#Book` and `#book` are one facet, displayed
 * with one deterministic casing.
 */
export async function listNoteTags(): Promise<NoteTagFacet[]> {
  return db
    .selectFrom('tags')
    .innerJoin('notes', 'notes.path', 'tags.notePath')
    .where('notes.dailyDate', 'is', null)
    .select([sql<string>`min(tags.tag)`.as('tag'), sql<number>`count(*)`.as('count')])
    .groupBy(sql`lower(tags.tag)`)
    .orderBy(sql`lower(tags.tag)`)
    .execute()
}
