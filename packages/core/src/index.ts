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
export { call, callBinary } from './ipc/invoke'
export {
  getAppVersion,
  getAppPlatform,
  isMobilePlatform,
  mobileStorage,
  icloudDownloadPending,
  icloudStatus,
  icloudAdoptGraph,
  icloudConflictsScan,
  icloudWatchStart,
  icloudWatchStop,
  type AppPlatform,
  type IcloudScanOptions,
  type IcloudStatus,
  type IcloudSweepOutcome,
  type MobileStorageInfo,
  type MobileStorageKind,
} from './ipc/commands'
export { confirmQuit, subscribeQuitRequested } from './app/quit'
export { toggleDevtools } from './app/devtools'

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
  TEMPLATES_DIR,
  ASSETS_DIR,
  AUDIO_MEMOS_DIR,
  dailyPath,
  notePath,
  templatePath,
  assetPath,
  audioMemoPath,
  descriptionPathFor,
  DESCRIPTION_SUFFIX,
  isDaily,
  isNotePath,
  isTemplatePath,
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
  openAsset,
  listDir,
  noteExists,
  deleteNote,
  listFiles,
  recentGraphs,
  forgetRecent,
  captureHostRegister,
  captureInboxList,
  captureInboxRead,
  captureInboxSpool,
  captureInboxReject,
  captureInboxRemove,
  captureMetaFetch,
  promoteCaptureScreenshot,
} from './graph/commands'
export { createAsset, importAsset } from './graph/assets'
export { assetFileName } from './graph/asset-names'
export {
  newNoteId,
  newNoteSource,
  untitledNoteSeed,
  untitledNotePath,
  isUntitledNotePath,
  createNoteWithTitle,
} from './graph/create-note'

// User settings (config-dir JSON document; Rust persists, this layer validates)
export {
  settingsSchema,
  editorMarkdownSyntaxSchema,
  editorSpellCheckSchema,
  editorDefaultBulletSchema,
  editorBulletAfterHeadingSchema,
  editorTextSizeSchema,
  semanticSearchEnabledSchema,
  describeAssetsSchema,
  contactsEnabledSchema,
  themePreferenceSchema,
  timeFormatSchema,
  dateFormatSchema,
  weekStartDaySchema,
  allNotesFilterTagsSchema,
  calendarEnabledSchema,
  calendarIdsSchema,
  graphColorSchema,
  graphColorsSchema,
  GRAPH_COLOR_IDS,
  aiProviderIdSchema,
  aiProviderConfigSchema,
  aiProvidersSchema,
  defaultAiProviderIdSchema,
  chatModelSelectionSchema,
  aiPromptModeSchema,
  aiPromptSchema,
  aiPromptsSchema,
  DEFAULT_SETTINGS,
  type Settings,
  type EditorMarkdownSyntax,
  type EditorTextSize,
  type ThemePreference,
  type TimeFormat,
  type DateFormat,
  type WeekStartDay,
  type AllNotesFilterTags,
  type CalendarIds,
  type GraphColor,
  type GraphColors,
  type AiProviderId,
  type AiProviderConfig,
  type AiPrompt,
  type AiPromptMode,
} from './settings/schema'
export { loadSettings, saveSettings } from './settings/commands'

// Apple Contacts (live CNContactStore reads; matching policy lives here)
export {
  contactsAuthorizationSchema,
  contactMatchSchema,
  contactsAuthorizationStatus,
  requestContactsAccess,
  lookupContactsByEmail,
  lookupContactsByName,
  isContactsReadable,
  type ContactsAuthorization,
  type ContactMatch,
} from './contacts/commands'
export {
  contactLinkSuggestions,
  contactNamesEqual,
  matchContactForTitle,
  suggestContactForTitle,
} from './contacts/match'
export {
  contactDetailsMarkdown,
  appendContactDetails,
  noteHasContactDetails,
} from './contacts/markdown'
export { pickContactForEmail, resolveAttendeeContact } from './contacts/resolve'

// AI providers & keychain secrets (Plan 10)
export {
  AI_PROVIDERS,
  aiProvider,
  aiModelLabel,
  DEFAULT_CONTEXT_WINDOW,
  modelContextWindow,
  type AiProviderInfo,
  type AiModelOption,
} from './ai/provider-catalog'
export { aiKeySecretName } from './ai/secrets'
export { setSecret, getSecret, deleteSecret } from './secrets/keychain'
export {
  KEY_HINT_LENGTH,
  TRANSCRIPTION_PROVIDERS,
  apiKeyHint,
  withAiProviderAdded,
  withAiProviderRemoved,
  defaultAiProvider,
  pickTranscriptionConfig,
  type AiProvidersState,
  type TranscriptionConfig,
  type TranscriptionProvider,
} from './ai/provider-config'
export {
  chatModelOptions,
  resolveChatModel,
  type ChatModelOption,
  type ChatModelSelection,
} from './ai/chat/model-options'
export { validateApiKey, type ApiKeyValidation } from './ai/validate-key'
export {
  assertCloudAllowed,
  cloudSafeGraphContext,
  cloudSafeNoteContent,
  cloudSafeNoteListings,
  cloudSafeSearchHits,
  cloudSafeSelection,
  isPrivateNoteError,
  PrivateNoteError,
  type CloudGraphContext,
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
  MAX_READ_NOTES,
  type ListDailyNotesOutput,
  type ListRecentNotesOutput,
  type NoteHitSummary,
  type NoteToolCall,
  type NoteToolDeps,
  type NoteToolResult,
  type NoteTools,
  type ReadNoteResult,
  type ReadNoteSummary,
  type ReadNotesOutput,
  type SearchNotesOutput,
} from './ai/chat/tools'
export { chatSystemPrompt, type SystemPromptInput } from './ai/chat/system-prompt'
export {
  loadChatGraphContext,
  MAX_CONTEXT_TAGS,
  type GraphContextDeps,
} from './ai/chat/graph-context'
export {
  streamChat,
  type ChatStreamEvent,
  type StreamChatOptions,
} from './ai/chat/stream-chat'
export {
  BUILT_IN_AI_PROMPTS,
  filterAiPrompts,
  renderSelectionPrompt,
} from './ai/selection-prompts'
export {
  transformSelection,
  type TransformSelectionOptions,
  type TransformStreamEvent,
} from './ai/transform-selection'
export {
  appendEvent,
  buildHistory,
  isToolPending,
  NO_REPLY_NOTICE,
  userMessage,
  type AssistantPart,
  type ChatAttachment,
  type ChatTurn,
} from './ai/chat/transcript'
export {
  deleteChatConversation,
  listChatConversations,
  loadChatMessages,
  saveChatMessage,
  type ChatConversation,
} from './ai/chat/store'
export {
  estimateTokens,
  fitToContextWindow,
  type ContextWindowOptions,
} from './ai/chat/context-window'
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
  audioMemoFromPath,
  audioMemoIdentity,
  captureAudioMemo,
  isSilentStop,
  listPendingAudioMemos,
  reconcileAudioMemos,
  type AudioMemoIdentity,
  type CaptureAudioMemoInput,
  type CaptureAudioMemoOutcome,
  type ReconcileAudioMemosInput,
  type ReconcileAudioMemosOutcome,
  type ReconcileStop,
} from './actions/audio-memo'

// Link capture (Plan 11) — the envelope also ships to the extension via the
// `./capture-envelope` subpath export (browser-safe, zod-only)
export {
  captureAckSchema,
  captureEnvelopeSchema,
  captureWireMessageSchema,
  inboxEnvelopeSchema,
  textCaptureEnvelopeSchema,
  textCaptureKindSchema,
  textCaptureSourceSchema,
  TEXT_CAPTURE_MAX_LENGTH,
  type CaptureAck,
  type CaptureEnvelope,
  type CaptureSource,
  type CaptureWireMessage,
  type InboxEnvelope,
  type TextCaptureEnvelope,
  type TextCaptureKind,
  type TextCaptureSource,
} from './actions/capture-envelope'
export {
  captureFromPath,
  captureIdentity,
  captureNoteMeta,
  drainCaptureInbox,
  isCaptureSpoolPath,
  listPendingCaptures,
  reconcileCaptureEnrichment,
  type CaptureIdentity,
  type CaptureNoteMeta,
  type CaptureStatus,
  type DrainCaptureInboxInput,
  type DrainCaptureInboxOutcome,
  type ReconcileCaptureEnrichmentInput,
  type ReconcileCaptureEnrichmentOutcome,
} from './actions/capture'
export { parsePageMeta, scrapePageMeta, type PageMeta } from './actions/meta-scrape'

// Calendar / meetings integration (docs/porting/calendar-meetings-integration.md)
export {
  calendarAuthorizationStatus,
  canReadCalendars,
  requestCalendarAccess,
  listCalendars,
  listCalendarEvents,
  subscribeCalendarChanged,
  calendarAuthorizationStatusSchema,
  calendarInfoSchema,
  calendarAttendeeSchema,
  calendarEventSchema,
  type CalendarAuthorizationStatus,
  type CalendarInfo,
  type CalendarAttendee,
  type CalendarEvent,
} from './calendar/commands'
export {
  displayEvents,
  isDeclinedByUser,
  defaultAttendees,
  dayRange,
} from './calendar/events'
export {
  addMeetingToDaily,
  meetingLine,
  MEETINGS_HEADING,
  type AddMeetingInput,
  type AddMeetingOutcome,
  type MeetingAttendee,
} from './actions/add-meeting'
export {
  describePage,
  isDescriptionRejected,
  DescriptionRejectedError,
  type DescribePageRequest,
} from './ai/describe-page'

// Asset descriptions (Plan 20)
export {
  isAssetDescriptionRejected,
  AssetDescriptionRejectedError,
  type AssetKind,
  type DescribeAssetRequest,
} from './ai/describe-asset'
export {
  buildDescriptionSource,
  classifyAsset,
  isEligibleAssetPath,
  reconcileAssetDescriptions,
  readManagedDescription,
  type AssetDescriptionMeta,
  type AssetDescriptionMode,
  type AssetVerdict,
  type ReconcileAssetDescriptionsInput,
  type ReconcileAssetDescriptionsOutcome,
} from './actions/asset-description'

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
  createGist,
  updateGist,
  deleteGist,
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
  type PublishedGist,
  type GistFile,
  type SyncEngine,
  type SyncEngineOptions,
  type SyncErrorKind,
  type SyncStatus,
} from './sync'

// Markdown document model (Plan 03)
export {
  frontmatterSchema,
  gistFrontmatterSchema,
  gistBodyHash,
  gistFilename,
  isPinned,
  pinnedOrder,
  PARSED_NOTE_VERSION,
  parseNote,
  appendBlock,
  appendUnderHeading,
  appendTaskLine,
  wikiLinkSafe,
  editTaskLine,
  removeTaskLine,
  parseTaskMarker,
  renameWikiLink,
  setTaskDueDate,
  clearTaskDueDate,
  taskLineToBullet,
  toggleTaskMarker,
  TaskStaleError,
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
  conflictMarkerBlockCount,
  conflictMarkerLabels,
  type ConflictMarkerLabels,
  parseBody,
  reflectMarkdownParser,
  wikiLinkExtension,
  scanInlineWikiLinks,
  scanInlineImages,
  scanInlineSegments,
  foldKey,
  foldTag,
  isTagName,
  hasAuthoredTitle,
  normalizeWikiTarget,
  slugForTitle,
  type ConflictResolution,
  type Frontmatter,
  type GistFrontmatter,
  type Span,
  type WikiLink,
  type MarkdownLink,
  type Heading,
  type AssetRef,
  type TaskMarker,
  type ParsedNote,
  type InlineWikiLink,
  type InlineImage,
  type InlineSegment,
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
  subscribeIndexApplied,
  subscribeFileChanges,
  emitFileChanges,
  setLocalWriteEcho,
  subscribeOwnWrites,
  subscribeIcloudConflicts,
  subscribeIcloudWatchFailed,
  applyIndexChanges,
  hashContent,
  buildIndexedNote,
  indexedNoteSchema,
  indexedLinkSchema,
  indexedAliasSchema,
  indexNote,
  reindexNotesReferencing,
  rebuildIndex,
  reconcileIndex,
  syncIndex,
  getIndexMeta,
  setIndexMeta,
  dailyDatesInRange,
  getBacklinks,
  getBacklinksWithContext,
  getConflictedNotes,
  getDuplicateNoteIds,
  getLinkSources,
  getNote,
  getNotesByTag,
  getOpenTasks,
  getCompletedTasks,
  groupTasks,
  taskDateBucket,
  listDailyNotes,
  listNotes,
  listNoteTags,
  listRecentNotes,
  getPinnedNotes,
  searchNotes,
  suggestWikiTargets,
  suggestTags,
  getIndexedHashes,
  resolveWikiTarget,
  resolveNoteTarget,
  rewriteLinksForTitleChange,
  nextAliases,
  availableNotePath,
  availableTemplatePath,
  slugPathForTitle,
  templateSlugPathForTitle,
  listTemplates,
  type TemplateEntry,
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
  type OpenTask,
  type TaskGroup,
  type TaskGroupKind,
  type NoteListEntry,
  type NoteListOptions,
  type NoteTagFacet,
  type RecentNoteRow,
  type RecentNotesOptions,
  type PinnedNote,
  type SearchHit,
  type TagSuggestion,
  type FileChange,
  type WikiSuggestion,
  type GeneratedDate,
  type DateSuggestionContext,
  type HighlightSegment,
  type ParsedSearchQuery,
  type SearchFilters,
  type FilteredSearchHit,
  type FilteredSearchOptions,
  type RenameIo,
  type TitleRenameRewriteOptions,
  type TitleRenameRewriteResult,
} from './indexing'
