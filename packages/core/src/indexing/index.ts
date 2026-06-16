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
export { setLocalWriteEcho } from './local-write-echo'
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
  getOpenTasks,
  getCompletedTasks,
  getPinnedNotes,
  searchNotes,
  suggestWikiTargets,
  suggestTags,
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
  type OpenTask,
  type PinnedNote,
  type SearchHit,
  type TagSuggestion,
} from './queries'
export { groupTasks, taskDateBucket, type TaskGroup, type TaskGroupKind } from './group-tasks'
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
export { rankWikiSuggestions, mergeDateSuggestions, type WikiSuggestion } from './suggest'
export {
  generateDateSuggestions,
  type DateSuggestion,
  type DateSuggestionContext,
} from './date-suggestions'
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
