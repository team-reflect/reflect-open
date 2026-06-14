import { sql } from 'kysely'
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

/** Non-daily notes for the All Notes screen, most recently edited first. */
export async function listNotes(options: NoteListOptions = {}): Promise<NoteListEntry[]> {
  const tag = options.tag ?? null

  const rows =
    tag === null
      ? await db
          .selectFrom('notes')
          .where('notes.dailyDate', 'is', null)
          .select(['notes.path', 'notes.title', 'notes.mtime', 'notes.preview'])
          .orderBy('notes.mtime', 'desc')
          .orderBy('notes.path')
          .execute()
      : await db
          .selectFrom('tags')
          .innerJoin('notes', 'notes.path', 'tags.notePath')
          .where('tags.tagKey', '=', foldTag(tag))
          .where('notes.dailyDate', 'is', null)
          .select(['notes.path', 'notes.title', 'notes.mtime', 'notes.preview'])
          .distinct()
          .orderBy('notes.mtime', 'desc')
          .orderBy('notes.path')
          .execute()

  if (rows.length === 0) {
    return []
  }

  // Tags for the same note set, via the same predicates — a join rather than a
  // `note_path IN (…)` list, which would put a per-row parameter between the
  // list and SQLite's bound-parameter ceiling.
  const tagRows =
    tag === null
      ? await db
          .selectFrom('tags')
          .innerJoin('notes', 'notes.path', 'tags.notePath')
          .where('notes.dailyDate', 'is', null)
          .select(['tags.notePath', 'tags.tag'])
          // Order on the folded key so a row's tags read in the same alphabetical
          // order as the facet list, regardless of display casing.
          .orderBy('tags.tagKey')
          .execute()
      : await db
          .selectFrom('tags')
          .innerJoin('notes', 'notes.path', 'tags.notePath')
          .innerJoin('tags as filterTags', 'filterTags.notePath', 'notes.path')
          .where('filterTags.tagKey', '=', foldTag(tag))
          .where('notes.dailyDate', 'is', null)
          .select(['tags.notePath', 'tags.tag'])
          .distinct()
          .orderBy('tags.tagKey')
          .execute()
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

/** One row of the recent-notes listing (the AI chat's recents tool). */
export interface RecentNoteRow {
  path: string
  title: string
  /** The indexed row preview (`buildIndexedNote`; may be empty). */
  preview: string
  /** File modification time (epoch ms). */
  mtime: number
  isPrivate: boolean
}

export interface RecentNotesOptions {
  /** Row cap — the most recently edited notes win. */
  limit: number
  /** Only notes carrying this tag (case-insensitive). `null` lists all. */
  tag?: string | null
}

/**
 * The most recently edited non-daily notes, newest first. Same population as
 * {@link listNotes} (dailies live in their own date-keyed listing) but capped,
 * without the per-note tag fetch, and with private notes excluded in SQL so
 * they don't consume cap slots — the AI privacy gate still re-checks every
 * row live before anything leaves the device.
 */
export async function listRecentNotes(options: RecentNotesOptions): Promise<RecentNoteRow[]> {
  const tag = options.tag ?? null

  const rows =
    tag === null
      ? await db
          .selectFrom('notes')
          .where('notes.dailyDate', 'is', null)
          .where('notes.isPrivate', '=', 0)
          .select(['notes.path', 'notes.title', 'notes.preview', 'notes.mtime', 'notes.isPrivate'])
          .orderBy('notes.mtime', 'desc')
          .orderBy('notes.path')
          .limit(options.limit)
          .execute()
      : await db
          .selectFrom('tags')
          .innerJoin('notes', 'notes.path', 'tags.notePath')
          .where('tags.tagKey', '=', foldTag(tag))
          .where('notes.dailyDate', 'is', null)
          .where('notes.isPrivate', '=', 0)
          .select(['notes.path', 'notes.title', 'notes.preview', 'notes.mtime', 'notes.isPrivate'])
          .distinct()
          .orderBy('notes.mtime', 'desc')
          .orderBy('notes.path')
          .limit(options.limit)
          .execute()
  return rows.map((row) => ({ ...row, isPrivate: row.isPrivate !== 0 }))
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
