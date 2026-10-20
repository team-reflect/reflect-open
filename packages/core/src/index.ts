/**
 * `@reflect/core` — the TypeScript business-logic layer.
 *
 * Per the architecture conventions, all reads, orchestration, AI/provider
 * calls, and privacy guards live here; the Rust shell provides only native
 * primitives reached through the injected bridge.
 *
 * API stability: the typed command bindings, schemas, and error contract are
 * the surface apps build on.
 */
export {
  createIpcBridgeService,
  INDEX_WRITTEN_EVENT,
  listenNow,
  type IpcBridge,
  type IpcBridgeService,
} from './ipc/ipc-service.ts'
export type { Unlisten } from './unlisten.ts'

export { type HapticsService } from './ipc/haptics-service.ts'
export { type AudioRecorderFinalSegment } from './audio/audio-recorder-service.ts'
export { type IcloudStatus } from './ipc/icloud-native-service.ts'
export {
  type MobileStorageInfo,
  type MobileStorageKind,
  type MobileStorageService,
} from './ipc/mobile-storage-service.ts'
export { githubAppInstallUrl, type GithubAuthService } from './sync/github-auth-service.ts'
export { newRepoUrl, parseRepoInput, type GithubRepoRef } from './sync/github-repo-service.ts'
export {
  type GitSyncService,
  type GitSyncState,
  type ConnectExistingResult,
} from './sync/git-sync-service.ts'
export { isICloudRoot } from './sync/icloud-sync-service.ts'
export { type GistPublishService } from './sync/gist-publish-service.ts'
export { isMobilePlatform, type AppPlatform } from './ports/platform-facts.ts'
export { createSystemClock, type ClockService, type TimerHandle } from './ports/clock-service.ts'
export { type IdService } from './ports/id-service.ts'
export { localIsoDate, parseIsoDate, todayIso } from './lib/dates.ts'
export { formatDayLabel, formatMonthDay, formatShortDate } from './lib/date-labels.ts'
export { type BuildPlatform, type PlatformFacts } from './ports/platform-facts.ts'
export { type FileSrcConverter } from './ports/file-src.ts'

export {
  createPathService,
  createPosixPathTransport,
  type PathService,
  type PathTransport,
} from './ports/path-service.ts'
export { type ActivityPort, type BackgroundTaskToken } from './ports/activity-port.ts'
export {
  createPersistenceFlushService,
  type PersistenceFlushService,
} from './graph/persistence-flush-service.ts'
export { createConsoleLogger, type LoggerService } from './ports/logger-service.ts'
export { type DecodedImage, type ImageCodecService } from './ports/image-codec-service.ts'
export { createBrowserHttpService, type HttpService } from './ports/http-service.ts'
export { type WebFetchService } from './link-preview/web-fetch-service.ts'
export { type NoteFileService } from './graph/note-file-service.ts'
export { type NoteLinkResolverService } from './graph/note-link-resolver-service.ts'
export { type NoteCreationService } from './graph/note-creation-service.ts'
export { dailyDeepLink, noteDeepLink } from './navigation/deep-link-format.ts'
export { DEEP_LINK_SCHEME, type DeepLink, type DeepLinkPlace } from './navigation/deep-link.ts'
export { isDeepLinkUrl, parseDeepLink } from './navigation/deep-link-parse.ts'
export {
  createNoDeepLinkSource,
  type DeepLinkIntakeService,
  type DeepLinkResolveOptions,
  type DeepLinkSource,
  type DeepLinkTarget,
} from './navigation/deep-link-intake-service.ts'
export { type CaptureInboxService } from './graph/capture-inbox-service.ts'
export { ambiguousNoteTitleMessage } from './graph/note-reference.ts'
export { normalizeWikiTarget } from './markdown/resolve.ts'
export {
  createAttachmentService,
  type AssetSaveError,
  type AttachmentService,
} from './documents/attachment-service.ts'
export {
  INITIAL_NOTE_SNAPSHOT,
  frontmatterPatchToYaml,
  type FrontmatterPatch,
  type NoteContentOrigin,
  type NoteSession,
  type NoteSessionOptions,
  type NoteSessionService,
  type NoteSessionSnapshot,
  type NoteSessionStatus,
} from './documents/note-session-service.ts'
export {
  UPDATED_PRESETS,
  updatedPresetFilter,
  type UpdatedFilter,
  type UpdatedPreset,
} from './search/all-notes-filters.ts'
export { createDailyNoteService, type DailyNoteService } from './daily/daily-note-service.ts'
export { type TemplateService } from './documents/template-service.ts'
export {
  isOstensiblyEmptyNoteSource,
  type NoteDocumentService,
} from './documents/note-document-service.ts'
export { type NotePreview, type NotePreviewService } from './documents/note-preview-service.ts'
export { canTrashNote, type NoteActionsService } from './documents/note-actions-service.ts'
export {
  applyNoteRowOverlay,
  applyNoteRowOverlays,
  applyPinnedNoteOverlays,
  type NoteListRowFacts,
  type NoteRowOverlay,
  type NoteRowOverlayPatch,
  type NoteRowService,
} from './documents/note-row-service.ts'
export { updatePinOrder } from './documents/pin-order.ts'
export { type OpenDocumentsService } from './documents/open-documents-service.ts'
export { type RenameCoordinator } from './documents/title-rename-service.ts'
export { createDocumentBinding, type DocumentBinding } from './documents/document-binding.ts'
export { type ResolvedArchivedPost } from './embeds/x-archive-service.ts'
export { marketingVersion } from './ports/app-info-service.ts'
export { reachWebStorage, type StorageService } from './ports/storage-service.ts'
export {
  type Operation,
  type OperationAction,
  type OperationHandle,
  type OperationOptions,
  type ProgressPort,
} from './ports/progress-port.ts'
export { createGraphSession, type GraphRole, type GraphSession } from './graph/graph-session.ts'
export {
  createCoreServices,
  type CoreAdapters,
  type CoreServices,
  type MobileServices,
} from './create-core-services.ts'
export {
  createGraphServices,
  openGraphLifecycle,
  type GraphLifecycle,
  type GraphLifecycleFlags,
  type GraphServices,
  type GraphServicesDeps,
} from './create-graph-services.ts'
export { type AgentSkillStatus } from './ai/agent-skill-service.ts'
export { type AgentSkillService } from './ai/agent-skill-service.ts'
export { type CalendarService } from './calendar/calendar-service.ts'
export {
  canPromptForContacts,
  contactsAccessNotice,
  isContactsAvailable,
  suggestedContactDetails,
} from './contacts/contact-suggestion-service.ts'
export {
  mergeAttendeeUpgrades,
  withAttendee,
  type MeetingService,
} from './contacts/meeting-service.ts'
export { createDatabaseService } from './indexing/database-service.ts'
export { type IndexQueryService } from './indexing/index-query-service.ts'
export {
  createWikiResolverService,
  type WikiResolverService,
} from './indexing/wiki-resolver-service.ts'
export { type BacklinkService } from './indexing/backlink-service.ts'
export { createSearchService, type SearchService } from './indexing/search-service.ts'
export { createSuggestionService, type SuggestionService } from './indexing/suggestion-service.ts'
export {
  type IndexFileProgress,
  type IndexLifecycleService,
} from './indexing/index-lifecycle-service.ts'
export { type AiPromptDraft, type AiPromptService } from './ai/ai-prompt-service.ts'
export {
  type AiProviderConfigService,
  type NewAiProvider,
} from './ai/ai-provider-config-service.ts'
export { type EmbedStatus, type EmbedProgress } from './embeddings/embedding-runtime-service.ts'
export {
  type RetrievalHit,
  type RetrievalService,
  type RetrieveOptions,
} from './embeddings/retrieval-service.ts'
export { type SemanticSearchService } from './embeddings/semantic-search-service.ts'
export { errorMessage, isAppError, toAppError, AppError } from './errors.ts'
export {
  dailyPath,
  notePath,
  assetPath,
  isDaily,
  isNotePath,
  dateFromDailyPath,
  foldGraphPath,
  isCalendarDate,
} from './graph/paths.ts'
export { noteBasenameKey } from './graph/note-reference.ts'
export {
  type GraphInfo,
  type RecentGraph,
  type FileMeta,
  type NoteCreateOutcome,
  type GraphImportProgress,
  type GraphImportSummary,
  type WindowBootstrap,
  windowBootstrapSchema,
} from './graph/schemas.ts'
export { type EmbedMediaService } from './embeds/embed-media-service.ts'

export {
  isUntitledNotePath,
  deferredCreationPolicy,
  type ResolveOrCreateNoteResult,
} from './graph/note-creation-service.ts'
export {
  type GraphSessionService,
  type GraphSessionState,
  type GraphStatus,
} from './graph/graph-session-service.ts'
export {
  createV1ImportService,
  type V1ImportService,
  type V1ImportState,
} from './graph/v1-import-service.ts'
export {
  DEFAULT_GRAPH_NAME,
  cleanGraphName,
  graphNameFromRoot,
  graphRootForName,
  isGraphNameTaken,
} from './graph/graph-names.ts'
export {
  settingsSchema,
  SIDEBAR_WIDTH_RANGE,
  CONTEXT_SIDEBAR_WIDTH_RANGE,
  clampSidebarWidth,
  TRANSCRIPTION_PROMPT_MAX_LENGTH,
  normalizeTranscriptionPrompt,
  timeFormatSchema,
  dateFormatSchema,
  weekStartDaySchema,
  weekStartDow,
  GRAPH_COLOR_IDS,
  aiProviderIdSchema,
  CHAT_SYSTEM_PROMPT_MAX_LENGTH,
  normalizeChatSystemPrompt,
  DEFAULT_SETTINGS,
  type Settings,
  type EditorMarkdownSyntax,
  type EditorTextSize,
  type SidebarWidthRange,
  type ThemePreference,
  type TimeFormat,
  type DateFormat,
  type WeekStartDay,
  type GraphColor,
  type AiProviderId,
  type AiProviderConfig,
  type HostedAiProviderConfig,
  type AiPrompt,
  type AiPromptMode,
} from './settings/schema.ts'
export { type SettingsLoadOutcome, type SettingsService } from './settings/settings-service.ts'
export { type ContactsAuthorization, type ContactMatch } from './contacts/commands.ts'
export {
  contactsCanLookup,
  lookupContactPeople,
  type ContactsService,
  type ContactsState,
} from './contacts/contacts-service.ts'
export { contactDetailsMarkdown } from './contacts/markdown.ts'
export {
  createPersonNoteService,
  type EnsurePersonNoteInput,
  type PersonContactResolution,
  type PersonNoteService,
} from './contacts/person-note-service.ts'
export { serializeWikiSuggestionAddress, type WikiLinkSuggestion } from './indexing/suggest.ts'
export { type ClassicAccess, type ClassicSignInResult } from './classic/classic-access-service.ts'
export {
  createClassicAccessService,
  type ClassicSignInOptions,
} from './classic/classic-access-service.ts'
export {
  createSubscriptionService,
  type ActiveSubscription,
} from './monetization/subscription-service.ts'
export {
  createAppStoreEnvironmentService,
  type AppStoreEnvironment,
} from './monetization/app-store-environment-service.ts'
export { createPaywallService, type PaywallGate } from './monetization/paywall-service.ts'
export {
  IAP_PRODUCT_IDS,
  createIapService,
  type IapProduct,
  type IapService,
} from './ipc/iap-service.ts'
export { createAppStoreService, type AppStoreService } from './ipc/app-store-service.ts'
export {
  AI_PROVIDERS,
  aiProvider,
  aiModelLabel,
  aiProviderRequiresApiKey,
  type AiProviderInfo,
  type AiModelOption,
} from './ai/provider-catalog.ts'
export { aiKeySecretName } from './ai/ai-credential-service.ts'
export {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  isPlainHttpRemoteBaseUrl,
} from './ai/openai-compatible.ts'
export { isHttpBaseUrl } from './lib/http-url.ts'

export { TRANSCRIPTION_PROVIDERS } from './ai/provider-config.ts'
export {
  chatModelOptions,
  type ChatModelOption,
  type ChatModelSelection,
} from './ai/chat/model-options.ts'
export { type CloudGraphContext, type CloudSafe } from './privacy/checkers.ts'
export { type NoteHitSummary } from './ai/chat/note-tools-service.ts'
export { chatSystemPrompt } from './ai/chat/system-prompt.ts'
export type { ChatStreamEvent } from './ai/chat/chat-engine-service.ts'
export {
  type ChatSession,
  type ChatSessionState,
  type ChatStatus,
} from './ai/chat/chat-session-service.ts'
export { readChatAttachment } from './ai/chat/chat-attachments.ts'
export { filterAiPrompts } from './ai/selection-prompts.ts'
export {
  isToolPending,
  type AssistantPart,
  type ChatAttachment,
  type ChatTurn,
} from './ai/chat/transcript.ts'
export { type ChatConversation } from './ai/chat/chat-history-service.ts'
export { audioMemoIdentity, audioMemoPartPath } from './audio/audio-memo.ts'
export {
  type AudioMemoPhase,
  type AudioMemoService,
  type AudioMemoSession,
  type AudioMemoSessionState,
} from './audio/audio-memo-service.ts'
export {
  type MobileAudioMemoService,
  type MobileAudioMemoSession,
  type MobileAudioMemoSessionState,
} from './audio/mobile-audio-memo-service.ts'
export {
  captureAckSchema,
  captureWireMessageSchema,
  type CaptureWireMessage,
} from './capture/capture-envelope.ts'
export {
  canReadCalendars,
  calendarEventSchema,
  type CalendarAuthorizationStatus,
  type CalendarInfo,
  type CalendarEvent,
} from './calendar/commands.ts'
export { dayRange, displayEvents, defaultAttendees } from './calendar/events.ts'
export { type MeetingAttendee } from './contacts/meeting-service.ts'
export {
  createLinkPreviewService,
  type LinkPreviewResolver,
  type LinkPreviewService,
  type LinkPreviewSession,
} from './link-preview/link-preview-service.ts'
export { parseLinkPreviewMeta } from './link-preview/metadata.ts'
export { cloudSafeLinkHref, notePrivate } from './privacy/checkers.ts'
export { suggestRepoName, type GithubAuth, type GithubUser } from './sync/index.ts'
export {
  isPinned,
  pinnedOrder,
  parseNote,
  getTaskDueDate,
  type TaskLocator,
  type TaskRow,
  type TaskSnapshot,
  resolved,
  unresolved,
  splitFrontmatter,
  upsertFrontmatter,
  displayNoteTitle,
  foldKey,
  foldTag,
  foldFallbackTitleKey,
  isTagName,
  type Frontmatter,
  type Span,
  type Heading,
  type Resolution,
} from './markdown/index.ts'
export {
  buildIndexedNote,
  CLAIM_TIER,
  encodeTaskBreadcrumbs,
  indexedNoteSchema,
  aliasHint,
  type TemplateEntry,
  parseHighlights,
  parseSearchQuery,
  type ParsedSearchQuery,
  type FilteredSearchOptions,
  type IndexedNote,
  type BacklinkContext,
  type BacklinkContextPage,
  type BacklinkSourceCursor,
  type SnippetTask,
  type DuplicateIdGroup,
  type NoteRow,
  type NoteListEntry,
  type NoteTagFacet,
  type PinnedNote,
  type WikiLinkSuggestionResult,
  type DateSuggestionContext,
  type FileChange,
  type WikiSuggestion,
  type HighlightSegment,
  type FilteredSearchHit,
} from './indexing/index.ts'
export { groupTaskContexts, type TaskContext, type TaskGroup } from './tasks/group-tasks.ts'
export { type OpenTask } from './tasks/open-task.ts'
export { resolveTaskEdit, type TaskDraftResolution } from './tasks/task-content.ts'
export { getTaskKey, isSameTask } from './tasks/task-identity.ts'
export { type InsertTaskTarget } from './tasks/task-insert-target.ts'
export { previousTaskKey, todaysDailyTarget } from './tasks/task-navigation.ts'
export { withDraftDueDate } from './tasks/task-schedule-content.ts'
export {
  withoutReopenedTasks,
  type TaskAction,
  type TaskService,
  type TaskWriteResult,
} from './tasks/task-service.ts'
export { composeVisibleTaskGroups, type TaskFilters } from './tasks/task-visibility.ts'
