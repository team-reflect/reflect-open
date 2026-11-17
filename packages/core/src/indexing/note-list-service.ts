import type { NoteListEntry, RecentNoteRow, TagFacet as NoteTagFacet } from '@reflect/types'
import { foldTag } from '../markdown/index.ts'
import type { DatabaseService } from './database-service.ts'

/**
 * The All Notes list: every regular note, pinned first then newest, optionally
 * narrowed to one tag. The unfiltered list excludes daily notes — the stream is
 * their home — but a tag filter includes tagged daily notes alongside regular
 * notes. Templates remain boilerplate, not graph content.
 * Uncapped: the screen virtualizes, the row
 * snippet is the stored `preview` column (derived once at index time), and
 * neither query carries a per-row parameter, so list size has no SQL ceiling.
 */

export type { NoteListEntry }

export interface NoteListOptions {
  /**
   * Only notes carrying this tag (case-insensitive). `null` lists all.
   */
  tag?: string | null
}

export type { RecentNoteRow }

export interface RecentNotesOptions {
  /**
   * Row cap — the most recently edited notes win.
   */
  limit: number
  /**
   * Only notes carrying this tag (case-insensitive). `null` lists all.
   */
  tag?: string | null
}

export type { NoteTagFacet }

export interface NoteListServiceDeps {
  readonly database: DatabaseService
}

/**
 * The All Notes list, the recent-notes listing and the tag facets.
 */
export interface NoteListService {
  /**
   * Notes for the All Notes screen: unfiltered lists include non-daily notes only;
   * tag-filtered lists include both regular and daily notes carrying the tag.
   * Pinned notes appear first (explicit pin order, then unordered pins), then most
   * recently edited — V1's list order.
   */
  listNotes(options?: NoteListOptions): Promise<NoteListEntry[]>
  /**
   * The most recently edited non-daily notes, newest first. Same population as
   * {@link NoteListService.listNotes} (dailies live in their own date-keyed listing) but capped,
   * without the per-note tag fetch, and with private notes excluded in SQL so
   * they don't consume cap slots — the AI privacy gate still re-checks every
   * row live before anything leaves the device.
   */
  listRecentNotes(options: RecentNotesOptions): Promise<RecentNoteRow[]>
  /**
   * Every tag carried by at least one non-daily note, with how many such notes
   * carry it, alphabetical. Grouped on the stored `tag_key`, matching the tag
   * filter (and the `#tag` search token): `#Book` and `#book` are one facet,
   * displayed with one deterministic casing.
   */
  listNoteTags(): Promise<NoteTagFacet[]>
}

class NoteListServiceImpl implements NoteListService {
  readonly #deps: NoteListServiceDeps

  constructor(deps: NoteListServiceDeps) {
    this.#deps = deps
  }

  async listNotes(options: NoteListOptions = {}): Promise<NoteListEntry[]> {
    return await this.#deps.database.read('index_list_notes', { tagKey: tagKeyOf(options.tag) })
  }

  async listRecentNotes(options: RecentNotesOptions): Promise<RecentNoteRow[]> {
    return await this.#deps.database.read('index_recent_notes', {
      limit: options.limit,
      tagKey: tagKeyOf(options.tag),
    })
  }

  async listNoteTags(): Promise<NoteTagFacet[]> {
    return await this.#deps.database.read('index_note_tags', {})
  }
}

function tagKeyOf(tag: string | null | undefined): string | null {
  return tag == null ? null : foldTag(tag)
}

export function createNoteListService(deps: NoteListServiceDeps): NoteListService {
  return new NoteListServiceImpl(deps)
}
