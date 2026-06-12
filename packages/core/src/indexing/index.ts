/**
 * `@reflect/core` indexing layer (Plan 04) — the TS pipeline that turns parsed
 * notes into the SQLite projection, plus the typed read getters over it.
 */
export {
  openIndex,
  applyIndexedNote,
  applyIndexedNotes,
  removeFromIndex,
  moveNoteIndexed,
  clearIndex,
  setIndexMeta,
  watchStart,
  watchStop,
} from './commands'
export {
  FILE_CHANGES_EVENT,
  subscribeFileChanges,
  emitFileChanges,
  type FileChange,
} from './file-changes'
export {
  subscribeIndexChanges,
  applyIndexChanges,
  type ApplyErrorHandler,
  type MovedHandler,
} from './live'
export { hashContent } from './hash'
export { availableNotePath, slugPathForTitle } from './note-paths'
export {
  buildIndexedNote,
  indexedNoteSchema,
  indexedLinkSchema,
  indexedTagSchema,
  indexedAliasSchema,
  PROJECTION_VERSION,
  type IndexedNote,
  type IndexedLink,
  type IndexedTag,
  type IndexedAlias,
} from './indexed-note'
export {
  indexNote,
  rebuildIndex,
  reconcileIndex,
  syncIndex,
  PROJECTION_VERSION_KEY,
  type IndexPassOptions,
} from './indexer'
export {
  dailyDatesInRange,
  getBacklinks,
  getBacklinksWithContext,
  getConflictedNotes,
  getDuplicateNoteIds,
  getIndexMeta,
  getLinkSources,
  getNote,
  getNotesByTag,
  getPinnedNotes,
  searchNotes,
  suggestWikiTargets,
  getIndexedHashes,
  listDailyNotes,
  resolveWikiTarget,
  type Backlink,
  type BacklinkContext,
  type ConflictedNote,
  type DailyNoteRow,
  type DailyNotesRange,
  type DuplicateIdGroup,
  type NoteRow,
  type PinnedNote,
  type SearchHit,
} from './queries'
export {
  listNotes,
  listNoteTags,
  listRecentNotes,
  type NoteListEntry,
  type NoteListOptions,
  type NoteTagFacet,
  type RecentNoteRow,
  type RecentNotesOptions,
} from './note-list'
export { rankWikiSuggestions, type WikiSuggestion } from './suggest'
export {
  parseHighlights,
  randomNotePath,
  HIGHLIGHT_START,
  HIGHLIGHT_END,
  type HighlightSegment,
} from './search'
export { lineSnippet, previewSnippet } from './snippet'
export { parseSearchQuery, type ParsedSearchQuery, type SearchFilters } from './filter-query'
export { searchWithFilters, type FilteredSearchHit } from './filtered-search'
export {
  rewriteLinksForTitleChange,
  nextAliases,
  type RenameIo,
  type TitleRenameRewriteOptions,
  type TitleRenameRewriteResult,
} from './rename'
