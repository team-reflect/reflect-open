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
  type EmbedProgress,
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
export {
  appErrorSchema,
  errorMessage,
  isAppError,
  toAppError,
  ReflectError,
  type AppError,
} from './errors'

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
  editorSpellCheckSchema,
  semanticSearchEnabledSchema,
  themePreferenceSchema,
  timeFormatSchema,
  dateFormatSchema,
  weekStartDaySchema,
  allNotesFilterTagsSchema,
  graphColorSchema,
  graphColorsSchema,
  GRAPH_COLOR_IDS,
  aiProviderIdSchema,
  aiModelConfigSchema,
  aiModelsSchema,
  defaultAiModelIdSchema,
  DEFAULT_SETTINGS,
  type Settings,
  type EditorMarkdownSyntax,
  type ThemePreference,
  type TimeFormat,
  type DateFormat,
  type WeekStartDay,
  type AllNotesFilterTags,
  type GraphColor,
  type GraphColors,
  type AiProviderId,
  type AiModelConfig,
} from './settings/schema'
export { loadSettings, saveSettings } from './settings/commands'

// AI providers & keychain secrets (Plan 10)
export {
  AI_PROVIDERS,
  aiProvider,
  aiModelLabel,
  type AiProviderInfo,
  type AiModelOption,
} from './ai/provider-catalog'
export { aiKeySecretName } from './ai/secrets'
export { setSecret, getSecret, deleteSecret } from './secrets/keychain'
export {
  KEY_HINT_LENGTH,
  apiKeyHint,
  withAiModelAdded,
  withAiModelRemoved,
  defaultAiModel,
  type AiModelsState,
} from './ai/models'
export { validateApiKey, type ApiKeyValidation } from './ai/validate-key'

// Backup & sync (Plan 12)
export {
  gitStatus,
  gitSetup,
  gitCommitAll,
  gitFetch,
  gitMergeRemote,
  gitPush,
  isDeviceFlowConfigured,
  saveGithubAuth,
  loadGithubAuth,
  clearGithubAuth,
  deviceFlowStart,
  deviceFlowPoll,
  runDeviceFlow,
  getGithubToken,
  gitDisconnect,
  gitClone,
  parseGithubRemote,
  githubRemoteUrl,
  createGithubRepo,
  getGithubRepo,
  createSyncEngine,
  isSyncError,
  type GitStatus,
  type CommitOutcome,
  type MergeOutcome,
  type PushOutcome,
  type SkippedFile,
  type ChangedFile,
  type GithubAuth,
  type DeviceFlowStart,
  type DevicePollResult,
  type GithubRepoRef,
  type GithubRepo,
  type SyncEngine,
  type SyncEngineOptions,
  type SyncErrorKind,
  type SyncStatus,
} from './sync'

// Markdown document model (Plan 03)
export {
  frontmatterSchema,
  isPinned,
  pinnedOrder,
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
  detectConflictMarkers,
  resolveConflictMarkers,
  parseBody,
  reflectMarkdownParser,
  wikiLinkExtension,
  scanInlineWikiLinks,
  scanInlineImages,
  foldKey,
  foldTag,
  isTagName,
  normalizeWikiTarget,
  type ConflictResolution,
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
  emitFileChanges,
  applyIndexChanges,
  hashContent,
  buildIndexedNote,
  indexedNoteSchema,
  indexedLinkSchema,
  indexedAliasSchema,
  indexNote,
  rebuildIndex,
  reconcileIndex,
  syncIndex,
  dailyDatesInRange,
  getBacklinks,
  getBacklinksWithContext,
  getConflictedNotes,
  getLinkSources,
  getNote,
  getNotesByTag,
  listNotes,
  listNoteTags,
  getPinnedNotes,
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
  type ConflictedNote,
  type NoteRow,
  type NoteListEntry,
  type NoteListOptions,
  type NoteTagFacet,
  type PinnedNote,
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
