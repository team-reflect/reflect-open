/**
 * `@reflect/core` — the TypeScript business-logic layer.
 *
 * Per the architecture conventions, all reads, orchestration, AI/provider
 * calls, and privacy guards live here; the Rust shell provides only native
 * primitives reached through the injected bridge. "Plan NN" references point
 * at the design docs in `docs/plans/`.
 *
 * API stability: the typed command bindings, schemas, and error contract are
 * the surface apps build on. Exports marked `(plumbing)` below are shared
 * internals (normalization keys, low-level parsers) published for the editor
 * and tests — they track internal contracts and may change with them.
 */
export { setBridge, hasBridge, type IpcBridge, type Unlisten } from './ipc/bridge'
export { call } from './ipc/invoke'
export { getAppVersion } from './ipc/commands'
export { confirmQuit, subscribeQuitRequested } from './app/quit'

// Embeddings & retrieval (Plan 09)
export { chunkNote, type NoteChunk } from './embeddings/chunk'
export {
  embedStatus,
  embedEnsure,
  embedTexts,
  embedApply,
  embedRemove,
  subscribeEmbedStatus,
  embedStatusSchema,
  type EmbedStatus,
  type EmbedChunkPayload,
} from './embeddings/commands'
export { embedNote, backfillEmbeddings } from './embeddings/pipeline'
export {
  retrieve,
  relatedNotes,
  fuseRanked,
  type RetrievalHit,
  type RetrieveOptions,
} from './embeddings/retrieve'
export { appErrorSchema, errorMessage, isAppError, toAppError, type AppError } from './errors'

// Graph & file storage (Plan 02)
export {
  DAILY_DIR,
  NOTES_DIR,
  ASSETS_DIR,
  dailyPath,
  notePath,
  assetPath,
  isDaily,
  dateFromDailyPath,
} from './graph/paths'
export {
  graphInfoSchema,
  recentGraphSchema,
  fileMetaSchema,
  type GraphInfo,
  type RecentGraph,
  type FileMeta,
} from './graph/schemas'
export {
  openGraph,
  createGraph,
  readNote,
  writeNote,
  writeAsset,
  moveNote,
  deleteNote,
  listFiles,
  recentGraphs,
  forgetRecent,
} from './graph/commands'

// User settings (config-dir JSON document; Rust persists, this layer validates)
export {
  settingsSchema,
  editorMarkdownSyntaxSchema,
  themePreferenceSchema,
  DEFAULT_SETTINGS,
  type Settings,
  type EditorMarkdownSyntax,
  type ThemePreference,
} from './settings/schema'
export { loadSettings, saveSettings } from './settings/commands'

// Markdown document model (Plan 03)
export {
  frontmatterSchema,
  PARSED_NOTE_VERSION,
  parseNote,
  appendUnderHeading,
  renameWikiLink,
  resolved,
  resolveWikiLink,
  resolveWikiLinkAsync,
  unresolved,
  // (plumbing) shared by the editor + indexer so grammar and key rules can't drift:
  splitFrontmatter,
  parseFrontmatter,
  upsertFrontmatter,
  parseBody,
  reflectMarkdownParser,
  wikiLinkExtension,
  scanInlineWikiLinks,
  scanInlineImages,
  foldKey,
  normalizeWikiTarget,
  type Frontmatter,
  type Span,
  type WikiLink,
  type MarkdownLink,
  type Heading,
  type AssetRef,
  type ParsedNote,
  type InlineWikiLink,
  type InlineImage,
  type FrontmatterSplit,
  type ParsedFrontmatter,
  type NormalizedTarget,
  type Resolution,
  type WikiLookup,
  type AsyncWikiLookup,
} from './markdown'

// Local index (Plan 04)
export {
  openIndex,
  applyIndexedNote,
  applyIndexedNotes,
  removeFromIndex,
  clearIndex,
  watchStart,
  watchStop,
  subscribeIndexChanges,
  subscribeFileChanges,
  applyIndexChanges,
  hashContent,
  buildIndexedNote,
  indexedNoteSchema,
  indexedLinkSchema,
  indexedAliasSchema,
  indexNote,
  rebuildIndex,
  reconcileIndex,
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
  rewriteLinksForTitleChange,
  nextAliases,
  parseHighlights,
  randomNotePath,
  parseSearchQuery,
  searchWithFilters,
  type IndexedNote,
  type IndexedLink,
  type IndexedAlias,
  type Backlink,
  type BacklinkContext,
  type NoteRow,
  type SearchHit,
  type FileChange,
  type WikiSuggestion,
  type HighlightSegment,
  type ParsedSearchQuery,
  type SearchFilters,
  type FilteredSearchHit,
  type RenameIo,
  type TitleRenameRewriteOptions,
  type TitleRenameRewriteResult,
} from './indexing'
