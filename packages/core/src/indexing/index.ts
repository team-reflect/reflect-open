/**
 * `@reflect/core` indexing layer (Plan 04) — the TS pipeline that turns parsed
 * notes into the SQLite projection, plus the typed read getters over it.
 */
export {
  openIndex,
  applyIndexedNote,
  applyIndexedNotes,
  removeFromIndex,
  clearIndex,
  watchStart,
  watchStop,
} from './commands'
export {
  FILE_CHANGES_EVENT,
  subscribeFileChanges,
  type FileChange,
} from './file-changes'
export {
  subscribeIndexChanges,
  applyIndexChanges,
  type ApplyErrorHandler,
} from './live'
export { hashContent } from './hash'
export {
  buildIndexedNote,
  indexedNoteSchema,
  indexedLinkSchema,
  indexedAliasSchema,
  type IndexedNote,
  type IndexedLink,
  type IndexedAlias,
} from './indexed-note'
export { indexNote, rebuildIndex, reconcileIndex, type IndexPassOptions } from './indexer'
export {
  dailyDatesInRange,
  getBacklinks,
  getBacklinksWithContext,
  getLinkSources,
  getNote,
  getNotesByTag,
  searchNotes,
  suggestWikiTargets,
  getIndexedHashes,
  resolveWikiTarget,
  type Backlink,
  type BacklinkContext,
  type NoteRow,
  type SearchHit,
} from './queries'
export { rankWikiSuggestions, type WikiSuggestion } from './suggest'
export {
  parseHighlights,
  randomNotePath,
  HIGHLIGHT_START,
  HIGHLIGHT_END,
  type HighlightSegment,
} from './search'
export { lineSnippet } from './snippet'
export { parseSearchQuery, type ParsedSearchQuery, type SearchFilters } from './filter-query'
export { searchWithFilters, type FilteredSearchHit } from './filtered-search'
export {
  rewriteLinksForTitleChange,
  nextAliases,
  type RenameIo,
  type TitleRenameRewriteOptions,
  type TitleRenameRewriteResult,
} from './rename'
