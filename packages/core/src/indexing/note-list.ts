import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely'
import type { Database } from '@reflect/db'
import { foldTag } from '../markdown'
import { db } from './db'

/**
 * The All Notes list: every non-daily note, newest first, optionally narrowed
 * to one tag. Daily notes are excluded by design — the stream is their home —
 * which mirrors the original app's notes list (`isDaily = 0` there,
 * `daily_date IS NULL` here). Uncapped: the screen virtualizes, the row
 * snippet is the stored `preview` column (derived once at index time), and
 * neither query carries a per-row parameter, so list size has no SQL ceiling.
 */

/** One row of the All Notes list. */
export interface NoteListEntry {
  path: string
  title: string
  /** The indexed row preview (`buildIndexedNote`; may be empty). */
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

/**
 * EXISTS predicate: the candidate `notes` row carries `tag`. Matching is on
 * the stored `tag_key` ({@link foldTag} at index time — the same collation as
 * the `#tag` search token). Shared by the note and per-note-tag queries so
 * the two can't disagree about what "filtered" means.
 */
function noteCarriesTag(tag: string) {
  const folded = foldTag(tag)
  return (eb: ExpressionBuilder<Database, 'notes'>): Expression<SqlBool> =>
    eb.exists(
      eb
        .selectFrom('tags')
        .select(sql<number>`1`.as('one'))
        .whereRef('tags.notePath', '=', 'notes.path')
        .where('tags.tagKey', '=', folded),
    )
}

/** Non-daily notes for the All Notes screen, most recently edited first. */
export async function listNotes(options: NoteListOptions = {}): Promise<NoteListEntry[]> {
  const tag = options.tag ?? null

  let query = db
    .selectFrom('notes')
    .where('notes.dailyDate', 'is', null)
    .select(['notes.path', 'notes.title', 'notes.mtime', 'notes.preview'])
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
    // Order on the folded key so a row's tags read in the same alphabetical
    // order as the facet list, regardless of display casing.
    .orderBy('tags.tagKey')
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
    snippet: row.preview,
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
 * carry it, alphabetical. Grouped on the stored `tag_key`, matching the tag
 * filter (and the `#tag` search token): `#Book` and `#book` are one facet,
 * displayed with one deterministic casing.
 */
export async function listNoteTags(): Promise<NoteTagFacet[]> {
  return db
    .selectFrom('tags')
    .innerJoin('notes', 'notes.path', 'tags.notePath')
    .where('notes.dailyDate', 'is', null)
    .select([sql<string>`min(tags.tag)`.as('tag'), sql<number>`count(*)`.as('count')])
    .groupBy('tags.tagKey')
    .orderBy('tags.tagKey')
    .execute()
}
