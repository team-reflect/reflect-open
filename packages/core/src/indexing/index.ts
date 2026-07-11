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
export { setLocalWriteEcho, subscribeOwnWrites } from './local-write-echo'
export { subscribeIcloudConflicts, subscribeIcloudWatchFailed } from './icloud-conflicts'
export { subscribeIndexApplied, type IndexAppliedListener } from './index-applied'
export { INDEX_WRITTEN_EVENT, subscribeIndexWritten } from './index-written'
export { NOTE_MOVED_EVENT, subscribeNoteMoved } from './note-moved'
export {
  subscribeIndexChanges,
  applyIndexChanges,
  type ApplyErrorHandler,
  type MovedHandler,
} from './live'
export { hashContent } from './hash'
export {
  availableTemplatePath,
  slugPathForTitle,
  templateSlugPathForTitle,
} from './note-paths'
export { listTemplates, type TemplateEntry } from './template-list'
export {
  buildIndexedNote,
  decodeTaskBreadcrumbs,
  encodeTaskBreadcrumbs,
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
  reindexNotesReferencing,
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
  suggestWikiTargets,
  suggestTags,
  getIndexedFileFacts,
  getIndexedFileFactsByPath,
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
  type TagSuggestion,
} from './queries'
export { resolveNoteTarget } from './resolve-target'
export {
  groupTaskContexts,
  groupTasks,
  taskDateBucket,
  type TaskContext,
  type TaskGroup,
  type TaskGroupKind,
} from './group-tasks'
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
export {
  rankWikiSuggestions,
  mergeDateSuggestions,
  type WikiSuggestion,
  type GeneratedDate,
} from './suggest'
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
export { lineAt, lineSnippet, previewSnippet } from './snippet'
export {
  blockContextAt,
  blockContextLinesAt,
  prepareBlockContext,
  type BlockContextLines,
  type BlockContextSource,
} from './block-context'
export { extractSnippetTasks, type SnippetTask } from './snippet-tasks'
export { parseSearchQuery, type ParsedSearchQuery, type SearchFilters } from './filter-query'
export {
  searchNotes,
  searchWithFilters,
  type FilteredSearchHit,
  type FilteredSearchOptions,
  type SearchHit,
} from './filtered-search'
export {
  rewriteLinksForTitleChange,
  nextAliases,
  type RenameIo,
  type TitleRenameRewriteOptions,
  type TitleRenameRewriteResult,
} from './rename'
