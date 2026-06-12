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
  AUDIO_MEMOS_DIR,
  dailyPath,
  notePath,
  assetPath,
  audioMemoPath,
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
  readAsset,
  listDir,
  noteExists,
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
  TRANSCRIPTION_PROVIDERS,
  apiKeyHint,
  withAiModelAdded,
  withAiModelRemoved,
  defaultAiModel,
  pickTranscriptionConfig,
  type AiModelsState,
  type TranscriptionConfig,
  type TranscriptionProvider,
} from './ai/models'
export { validateApiKey, type ApiKeyValidation } from './ai/validate-key'
export {
  assertCloudAllowed,
  cloudSafeNoteContent,
  cloudSafeNoteListings,
  cloudSafeSearchHits,
  isPrivateNoteError,
  PrivateNoteError,
  type CloudNoteContent,
  type CloudNoteListing,
  type CloudSafe,
  type CloudSearchHit,
  type CloudSendable,
} from './ai/checkers'
export {
  buildNoteTools,
  MAX_DAILY_NOTE_DAYS,
  MAX_NOTE_CONTENT_CHARS,
  type ListDailyNotesOutput,
  type ListRecentNotesOutput,
  type NoteHitSummary,
  type NoteToolCall,
  type NoteToolDeps,
  type NoteToolResult,
  type NoteTools,
  type ReadNoteOutput,
  type SearchNotesOutput,
} from './ai/chat/tools'
export { chatSystemPrompt, type SystemPromptInput } from './ai/chat/system-prompt'
export {
  streamChat,
  type ChatStreamEvent,
  type StreamChatOptions,
} from './ai/chat/stream-chat'
export type { ModelMessage as ChatModelMessage } from 'ai'
// The fixed per-provider model ids stay internal to `ai/transcribe` —
// exporting them would let callers couple to vendor model names.
export {
  isTranscriptionRejected,
  transcribeAudio,
  TranscriptionRejectedError,
  type TranscriptionRequest,
} from './ai/transcribe'

// Capture actions (audio memos; Plan 11's link capture joins here)
export {
  appendToDailyNote,
  audioMemoFromPath,
  audioMemoIdentity,
  captureAudioMemo,
  listPendingAudioMemos,
  reconcileAudioMemos,
  type AppendToDailyNoteInput,
  type AudioMemoIdentity,
  type CaptureAudioMemoInput,
  type CaptureAudioMemoOutcome,
  type ReconcileAudioMemosInput,
  type ReconcileAudioMemosOutcome,
  type ReconcileStop,
} from './actions/audio-memo'

// Backup & sync (Plan 12)
export {
  gitStatus,
  gitSetup,
  gitCommitAll,
  gitFetch,
  gitMergeRemote,
  gitPush,
  isDeviceFlowConfigured,
  githubAppInstallUrl,
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
  newRepoUrl,
  createGithubRepo,
  getGithubRepo,
  getAuthenticatedUser,
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
  type GithubUser,
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
  appendBlock,
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
  hasAuthoredTitle,
  normalizeWikiTarget,
  slugForTitle,
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
  moveNoteIndexed,
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
  getDuplicateNoteIds,
  getLinkSources,
  getNote,
  getNotesByTag,
  listDailyNotes,
  listNotes,
  listNoteTags,
  listRecentNotes,
  getPinnedNotes,
  searchNotes,
  suggestWikiTargets,
  getIndexedHashes,
  resolveWikiTarget,
  rewriteLinksForTitleChange,
  nextAliases,
  availableNotePath,
  slugPathForTitle,
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
  type DailyNoteRow,
  type DailyNotesRange,
  type DuplicateIdGroup,
  type NoteRow,
  type NoteListEntry,
  type NoteListOptions,
  type NoteTagFacet,
  type RecentNoteRow,
  type RecentNotesOptions,
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
