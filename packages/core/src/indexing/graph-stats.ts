import { sql } from 'kysely'
import { db } from './db'
import type { NoteTagFacet } from './note-list'

/**
 * Graph-level aggregates for the AI chat's system prompt (the "graph
 * overview" block): how many notes the assistant can see, the span of the
 * daily journal, and which tags exist — so the model types tag filters and
 * date ranges from knowledge instead of guessing.
 *
 * Every figure is computed over `is_private = 0` rows only. These are
 * provider-bound aggregates; the privacy contract is documented on
 * `cloudSafeGraphContext` in `../privacy/checkers`, which is the only way this
 * data reaches a prompt.
 */

/** The aggregates of one graph, private notes excluded throughout. */
export interface GraphStats {
  /** Non-daily notes the assistant can list or read. */
  noteCount: number
  /** Days with a (non-private) daily note. */
  dailyNoteCount: number
  /** ISO date of the first daily note, `null` when there are none. */
  earliestDailyDate: string | null
  /** ISO date of the latest daily note, `null` when there are none. */
  latestDailyDate: string | null
  /** Tag facets over non-daily notes, most-used first then alphabetical. */
  tags: NoteTagFacet[]
  /** The facet list was capped at `tagLimit` — more tags exist. */
  tagsTruncated: boolean
}

export interface GraphStatsOptions {
  /** Facet cap — the most-used tags win (prompt token budget, not recall). */
  tagLimit: number
}

/** Load {@link GraphStats} from the active graph's index. */
export async function loadGraphStats({ tagLimit }: GraphStatsOptions): Promise<GraphStats> {
  const [noteRow, dailyRow, tagRows] = await Promise.all([
    db
      .selectFrom('notes')
      .where('kind', '=', 'note')
      .where('isPrivate', '=', 0)
      .select(sql<number>`count(*)`.as('count'))
      .executeTakeFirst(),
    db
      .selectFrom('notes')
      .where('dailyDate', 'is not', null)
      .where('isPrivate', '=', 0)
      .select([
        sql<number>`count(*)`.as('count'),
        sql<string | null>`min(daily_date)`.as('earliest'),
        sql<string | null>`max(daily_date)`.as('latest'),
      ])
      .executeTakeFirst(),
    // The same facet shape as `listNoteTags` (grouped on the stored folded
    // `tag_key`, one deterministic display casing), narrowed to non-private
    // notes and capped one past the limit so truncation is detectable.
    db
      .selectFrom('tags')
      .innerJoin('notes', 'notes.path', 'tags.notePath')
      .where('notes.kind', '=', 'note')
      .where('notes.isPrivate', '=', 0)
      .select([sql<string>`min(tags.tag)`.as('tag'), sql<number>`count(*)`.as('count')])
      .groupBy('tags.tagKey')
      .orderBy(sql`count(*)`, 'desc')
      .orderBy('tags.tagKey')
      .limit(tagLimit + 1)
      .execute(),
  ])
  const tagsTruncated = tagRows.length > tagLimit
  return {
    noteCount: noteRow?.count ?? 0,
    dailyNoteCount: dailyRow?.count ?? 0,
    earliestDailyDate: dailyRow?.earliest ?? null,
    latestDailyDate: dailyRow?.latest ?? null,
    tags: tagsTruncated ? tagRows.slice(0, tagLimit) : tagRows,
    tagsTruncated,
  }
}
