export {
  FILE_CHANGES_EVENT,
  RECONCILE_EVENT,
  type FileChange,
  type FileChangeSource,
} from './file-change-service.ts'
export type { ApplyErrorHandler, MovedHandler } from './live.ts'
export { type TemplateEntry } from './index-query-service.ts'
export {
  buildIndexedNote,
  CLAIM_TIER,
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
} from './indexed-note.ts'
export { PROJECTION_VERSION_KEY, type IndexPassOptions } from './indexer.ts'
export {
  type Backlink,
  type BacklinkContext,
  type BacklinkContextPage,
  type BacklinkContextPageOptions,
  type BacklinkSourceCursor,
} from './backlink-service.ts'
export { type DuplicateIdGroup, type NoteRow, type PinnedNote } from './index-query-service.ts'
export { type DailyNoteRow, type DailyNotesRange } from '../daily/daily-note-service.ts'
export { type TagSuggestion, type WikiLinkSuggestionResult } from './suggestion-service.ts'

export {
  type NoteListEntry,
  type NoteListOptions,
  type NoteTagFacet,
  type RecentNoteRow,
  type RecentNotesOptions,
} from './note-list-service.ts'
export {
  aliasHint,
  rankWikiSuggestions,
  mergeDateSuggestions,
  serializeWikiSuggestionAddress,
  type WikiLinkSuggestion,
  type WikiSuggestion,
  type GeneratedDate,
} from './suggest.ts'
export type { DateSuggestion, DateSuggestionContext } from './date-suggestion-types.ts'
export { generateDateSuggestions } from './date-suggestions.ts'
export { parseHighlights, HIGHLIGHT_START, HIGHLIGHT_END, type HighlightSegment } from './search.ts'
export { previewSnippet } from './snippet.ts'
export {
  blockContextAt,
  blockContextLinesAt,
  prepareBlockContext,
  type BlockContextLines,
  type BlockContextSource,
} from './block-context.ts'
export { extractSnippetTasks, type SnippetTask } from './snippet-tasks.ts'
export { parseSearchQuery, type ParsedSearchQuery, type SearchFilters } from './filter-query.ts'
export { type FilteredSearchHit, type FilteredSearchOptions } from './search-service.ts'
export {
  rewriteLinksForTitleChange,
  rewritePathLinksForMove,
  nextAliases,
  type RenameBacklink,
  type RenameIo,
  type TitleRenameRewriteOptions,
  type TitleRenameRewriteResult,
} from './rename.ts'
