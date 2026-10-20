import type { GraphRole, GraphSession } from './graph/graph-session.ts'
import { createAiCredentialService, type AiCredentialService } from './ai/ai-credential-service.ts'
import {
  createAiKeyValidationService,
  type AiKeyValidationService,
} from './ai/ai-key-validation-service.ts'
import { createAiPromptService, type AiPromptService } from './ai/ai-prompt-service.ts'
import {
  createAiProviderConfigService,
  type AiProviderConfigService,
} from './ai/ai-provider-config-service.ts'
import {
  createAssetDescriberService,
  type AssetDescriberService,
} from './ai/asset-describer-service.ts'
import {
  createPageDescriberService,
  type PageDescriberService,
} from './ai/page-describer-service.ts'
import {
  createSelectionTransformService,
  type SelectionTransformService,
} from './ai/selection-transform-service.ts'
import {
  createTranscriptEnrichmentService,
  type TranscriptEnrichmentService,
} from './ai/transcript-enrichment-service.ts'
import {
  createTranscriptionService,
  type TranscriptionService,
} from './ai/transcription-service.ts'
import {
  createLanguageModelService,
  createLazyAiSdkLoader,
  type LanguageModelService,
} from './ai/language-model-service.ts'
import { createChatEngineService, type ChatEngineService } from './ai/chat/chat-engine-service.ts'
import {
  createChatGraphContextService,
  type ChatGraphContextService,
} from './ai/chat/chat-graph-context-service.ts'
import {
  createChatHistoryService,
  type ChatHistoryService,
} from './ai/chat/chat-history-service.ts'
import {
  createChatSessionService,
  type ChatSessionService,
} from './ai/chat/chat-session-service.ts'
import { fitToContextWindow } from './ai/chat/context-window.ts'
import { createNoteToolsService, type NoteToolsService } from './ai/chat/note-tools-service.ts'
import { createAssetReferences } from './indexing/asset-refs.ts'

import {
  createBacklinkTargetService,
  type BacklinkTargetService,
} from './capture/backlink-target-service.ts'
import { createCaptureService, type CaptureService } from './capture/capture-service.ts'
import { createAudioMemoService, type AudioMemoService } from './audio/audio-memo-service.ts'
import {
  createMobileAudioMemoService,
  type MobileAudioMemoService,
} from './audio/mobile-audio-memo-service.ts'
import { createNativeActionService } from './audio/native-action-service.ts'
import {
  createAssetDescriptionService,
  type AssetDescriptionService,
} from './assets/asset-description-service.ts'
import {
  createAssetPrivacyService,
  type AssetPrivacyService,
} from './assets/asset-privacy-service.ts'
import {
  createCaptureInboxService,
  type CaptureInboxService,
} from './graph/capture-inbox-service.ts'
import {
  createDeepLinkIntakeService,
  createNoDeepLinkSource,
  type DeepLinkIntakeService,
  type DeepLinkSource,
} from './navigation/deep-link-intake-service.ts'
import { createICloudNativeService, type ICloudNativeService } from './ipc/icloud-native-service.ts'
import {
  createGitRepositoryService,
  type GitRepositoryService,
} from './sync/git-repository-service.ts'
import { createGistService, type GistService } from './sync/gist-service.ts'
import { createGistPublishService, type GistPublishService } from './sync/gist-publish-service.ts'
import { createGithubAuthService, type GithubAuthService } from './sync/github-auth-service.ts'
import { createGithubRepoService, type GithubRepoService } from './sync/github-repo-service.ts'
import { createSyncEngineFactory, type SyncEngineFactory } from './sync/engine.ts'
import type { GitSyncServiceDeps } from './sync/git-sync-service.ts'
import type { ICloudDownloadServiceDeps } from './sync/icloud-download-service.ts'
import {
  createICloudMigrationService,
  type ICloudMigrationService,
} from './sync/icloud-migration-service.ts'
import type { ICloudSyncServiceDeps } from './sync/icloud-sync-service.ts'
import { createXArchiveService, type XArchiveService } from './embeds/x-archive-service.ts'
import { createEmbedMediaService, type EmbedMediaService } from './embeds/embed-media-service.ts'
import {
  createLinkPreviewService,
  type LinkPreviewService,
} from './link-preview/link-preview-service.ts'
import { parseLinkPreviewMeta } from './link-preview/metadata.ts'
import { createWebFetchService, type WebFetchService } from './link-preview/web-fetch-service.ts'
import { createPlatformAudioRecorder } from './audio/platform-audio-recorder.ts'
import {
  createClassicAccessService,
  type ClassicAccessService,
} from './classic/classic-access-service.ts'
import {
  createAppStoreEnvironmentService,
  type AppStoreEnvironmentService,
} from './monetization/app-store-environment-service.ts'
import { createPaywallService, type PaywallService } from './monetization/paywall-service.ts'
import {
  createSubscriptionService,
  type SubscriptionService,
} from './monetization/subscription-service.ts'
import { createCalendarService, type CalendarService } from './calendar/calendar-service.ts'
import {
  createContactSuggestionService,
  type ContactSuggestionService,
} from './contacts/contact-suggestion-service.ts'
import { createContactsService, type ContactsService } from './contacts/contacts-service.ts'
import { createMeetingService, type MeetingService } from './contacts/meeting-service.ts'
import { createPersonNoteService, type PersonNoteService } from './contacts/person-note-service.ts'
import { createAssetStoreService, type AssetStoreService } from './graph/asset-store-service.ts'
import {
  createNoteCreationService,
  type NoteCreationService,
} from './graph/note-creation-service.ts'
import { createNoteFileService, type NoteFileService } from './graph/note-file-service.ts'
import {
  createGraphSessionService,
  type GraphSessionService,
} from './graph/graph-session-service.ts'
import { createDailyNoteService, type DailyNoteService } from './daily/daily-note-service.ts'
import { createAttachmentService, type AttachmentService } from './documents/attachment-service.ts'
import { createNoteMoveService, type NoteMoveService } from './documents/note-move-service.ts'
import {
  createTitleRenameService,
  type TitleRenameService,
} from './documents/title-rename-service.ts'
import {
  createNoteActionsService,
  type NoteActionsService,
} from './documents/note-actions-service.ts'
import { createNoteRowService, type NoteRowService } from './documents/note-row-service.ts'
import { createTemplateService, type TemplateService } from './documents/template-service.ts'
import {
  createNoteDocumentService,
  type NoteDocumentService,
} from './documents/note-document-service.ts'
import {
  createNotePreviewService,
  type NotePreviewService,
} from './documents/note-preview-service.ts'
import {
  createNoteSessionService,
  type NoteSessionService,
} from './documents/note-session-service.ts'
import {
  createOpenDocumentsService,
  type OpenDocumentsService,
} from './documents/open-documents-service.ts'
import {
  createNoteLinkResolverService,
  type NoteLinkResolverService,
} from './graph/note-link-resolver-service.ts'
import {
  createEmbeddingRuntimeService,
  type EmbeddingRuntimeService,
} from './embeddings/embedding-runtime-service.ts'
import {
  createEmbeddingIndexService,
  type EmbeddingIndexService,
} from './embeddings/embedding-index-service.ts'
import { createRetrievalService, type RetrievalService } from './embeddings/retrieval-service.ts'
import {
  createSemanticSearchService,
  type SemanticSearchService,
} from './embeddings/semantic-search-service.ts'
import { createDatabaseService, type DatabaseService } from './indexing/database-service.ts'
import { createBacklinkService, type BacklinkService } from './indexing/backlink-service.ts'
import { createFileChangeService, type FileChangeService } from './indexing/file-change-service.ts'
import { createGraphStatsService, type GraphStatsService } from './indexing/graph-stats-service.ts'
import {
  createIndexLifecycleService,
  type IndexLifecycleService,
} from './indexing/index-lifecycle-service.ts'
import { createIndexQueryService, type IndexQueryService } from './indexing/index-query-service.ts'
import { createNoteListService, type NoteListService } from './indexing/note-list-service.ts'
import { createNotePathService, type NotePathService } from './indexing/note-path-service.ts'
import { createSearchService, type SearchService } from './indexing/search-service.ts'
import { createSuggestionService, type SuggestionService } from './indexing/suggestion-service.ts'
import {
  createWikiResolverService,
  type WikiResolverService,
} from './indexing/wiki-resolver-service.ts'
import { createIndexStoreService, type IndexStoreService } from './indexing/index-store-service.ts'
import { createAppStoreService } from './ipc/app-store-service.ts'
import { createIapService } from './ipc/iap-service.ts'
import type { IpcBridgeService } from './ipc/ipc-service.ts'
import {
  createMobileStorageService,
  type MobileStorageService,
} from './ipc/mobile-storage-service.ts'
import { createHapticsService, type HapticsService } from './ipc/haptics-service.ts'
import { createWebAuthService, type WebAuthService } from './ipc/web-auth-service.ts'
import {
  createSecretStoreService,
  type SecretStoreService,
} from './secrets/secret-store-service.ts'
import { createPrivacyService, type PrivacyService } from './privacy/privacy-service.ts'
import { createSettingsService, type SettingsService } from './settings/settings-service.ts'
import { createAgentSkillService, type AgentSkillService } from './ai/agent-skill-service.ts'
import { createAppInfoService, type AppInfoService } from './ports/app-info-service.ts'
import { createBackgroundReconcilerFactory } from './reconcile/background-reconciler.ts'
import type { ClockService } from './ports/clock-service.ts'
import type { HttpService } from './ports/http-service.ts'
import { createSystemIdService, type IdService } from './ports/id-service.ts'
import { isMobilePlatform } from './ports/platform-facts.ts'
import type { ActivityPort } from './ports/activity-port.ts'
import type { ProgressPort } from './ports/progress-port.ts'
import { createUnavailableImageCodec, type ImageCodecService } from './ports/image-codec-service.ts'
import type { LoggerService } from './ports/logger-service.ts'
import { createTaskService, type TaskService } from './tasks/task-service.ts'
import { createPathService, type PathService, type PathTransport } from './ports/path-service.ts'
import {
  createPersistenceFlushService,
  type PersistenceFlushService,
} from './graph/persistence-flush-service.ts'
import { appleFileSrc, type FileSrcConverter } from './ports/file-src.ts'
import type { PlatformFacts } from './ports/platform-facts.ts'
import { createWebStorageService, type StorageService } from './ports/storage-service.ts'
import type { GraphServices, GraphServicesDeps } from './create-graph-services.ts'
import type { AudioRecorderService } from './audio/audio-recorder-service.ts'

/**
 * The app-scoped services: one instance each for the lifetime of the webview.
 */
export interface CoreServices {
  /**
   * The typed IPC boundary that turns an untyped native response into a validated domain value.
   */
  readonly ipc: IpcBridgeService
  /**
   * Diagnostic logging.
   */
  readonly logger: LoggerService
  /**
   * Wall time, monotonic time, the local date, and timers.
   */
  readonly clock: ClockService
  /**
   * Fresh random identifiers.
   */
  readonly id: IdService
  /**
   * What the host is and can do, decided once at startup.
   */
  readonly platform: PlatformFacts
  /**
   * Key-value storage that outlives a page (`local`) or a session (`session`).
   */
  readonly storage: StorageService
  /**
   * Host filesystem path building, in the host platform's path syntax.
   */
  readonly path: PathService
  /**
   * Facts about the running application build.
   */
  readonly appInfo: AppInfoService
  /**
   * Live reads of the OS calendar database.
   */
  readonly calendar: CalendarService
  /**
   * Live reads of the OS address book, and the permission state as a store.
   */
  readonly contacts: ContactsService
  /**
   * Offers the Apple Contact whose name matches a note's title as a suggested-contact card.
   */
  readonly contactSuggestions: ContactSuggestionService
  /**
   * Adds a calendar event to its daily note, with the attendee resolution around it.
   */
  readonly meetings: MeetingService
  /**
   * Manages the open graph's agent skill file under `~/.agents/skills/`.
   */
  readonly agentSkill: AgentSkillService
  /**
   * The native side of mobile graph storage.
   */
  readonly mobileStorage: MobileStorageService
  /**
   * Decodes and re-encodes image files.
   */
  readonly imageCodec: ImageCodecService
  /**
   * The global settings document: loaded once, patched in memory, and saved one write at a time.
   */
  readonly settings: SettingsService
  /**
   * Lands dirty state before the app exits or the OS suspends it.
   */
  readonly persistenceFlush: PersistenceFlushService
  /**
   * One stream of "files changed" for the open graph, merging native watcher events with in-process batches.
   */
  readonly fileChanges: FileChangeService
  /**
   * The local embedding model: download, load, status, and text vectors.
   */
  readonly embeddingRuntime: EmbeddingRuntimeService
  /**
   * The graph's persisted chat conversations.
   */
  readonly chatHistory: ChatHistoryService
  /**
   * The `reflect://` intake of this webview: buffers incoming URLs and resolves them.
   */
  readonly deepLinkIntake: DeepLinkIntakeService
  /**
   * Wiki-target resolution over the index's claims and keys.
   */
  readonly wikiResolver: WikiResolverService
  /**
   * Decides which existing note a `[[wiki link]]` or Markdown href points at.
   */
  readonly noteLinkResolver: NoteLinkResolverService
  /**
   * The one GitHub sign-in of this machine, kept in the keychain.
   */
  readonly githubAuth: GithubAuthService
  /**
   * Publishes a note as a secret GitHub gist, and takes it down again.
   */
  readonly gistPublish: GistPublishService
  /**
   * The native side of the iCloud Drive container.
   */
  readonly icloudNative: ICloudNativeService
  /**
   * Moves a local graph into the iCloud Drive container.
   */
  readonly icloudMigration: ICloudMigrationService
  /**
   * The embedded media of the editor's cards: X posts and YouTube videos.
   */
  readonly embedMedia: EmbedMediaService
  /**
   * The privacy-gated expansion of the HTTP(S) links in a note.
   */
  readonly linkPreview: LinkPreviewService
  /**
   * Reflect Open access through a paid Reflect Classic account.
   */
  readonly classicAccess: ClassicAccessService
  /**
   * Resolves, displays, opens, and saves note attachments.
   */
  readonly attachments: AttachmentService
  /**
   * Creates the document session of each open note.
   */
  readonly noteSessions: NoteSessionService
  /**
   * The open note documents, as one app-global registry.
   */
  readonly openDocuments: OpenDocumentsService
  /**
   * Moves note files, and tells the rest of the app that a note now lives somewhere else.
   */
  readonly noteMove: NoteMoveService
  /**
   * Keeps inbound links, aliases and filenames following each note's settled title.
   */
  readonly titleRename: TitleRenameService
  /**
   * Reads and writes a note from an in-app action through the open session when there is one, otherwise the disk.
   */
  readonly noteDocuments: NoteDocumentService
  /**
   * Read-only previews of the note that a link points at.
   */
  readonly notePreview: NotePreviewService
  /**
   * Reads, edits and adds round-checkbox tasks across notes.
   */
  readonly tasks: TaskService
  /**
   * The user's actions on one note that are not edits: pin, private, trash, copy deep link, copy path.
   */
  readonly noteActions: NoteActionsService
  /**
   * The optimistic read overlay for note index rows.
   */
  readonly noteRows: NoteRowService
  /**
   * The date questions about notes: today, which days have a daily note, and the wake onto a new day.
   */
  readonly dailyNotes: DailyNoteService
  /**
   * Note templates: read, insert, create, and manage the Markdown files under `templates/`.
   */
  readonly templates: TemplateService
  /**
   * Row lookups over the index's `notes` and `aliases` tables.
   */
  readonly indexQuery: IndexQueryService
  /**
   * Incoming links of a note, raw or with their rendered block context.
   */
  readonly backlinks: BacklinkService
  /**
   * The palette's full-text search with filters.
   */
  readonly search: SearchService
  /**
   * The All Notes list, the recent-notes listing and the tag facets.
   */
  readonly noteList: NoteListService
  /**
   * Readable, collision-free paths for note and template titles.
   */
  readonly notePath: NotePathService
  /**
   * Creates notes with a title-derived filename and a ULID frontmatter `id`.
   */
  readonly noteCreation: NoteCreationService
  /**
   * The active graph's index lifecycle: open, reconcile, watch, suspend, resume, and rebuild.
   */
  readonly indexLifecycle: IndexLifecycleService
  /**
   * The active graph; its state carries the graph-scoped services of the open session.
   */
  readonly graphSession: GraphSessionService<GraphServices>
  /**
   * The opt-in local semantic search: model download, load, and re-embedding after an index rebuild.
   */
  readonly semanticSearch: SemanticSearchService
  /**
   * The saved AI prompts of the editor AI menu's user library.
   */
  readonly aiPrompts: AiPromptService
  /**
   * The configured AI provider entries, and which entry each AI feature uses.
   */
  readonly aiProviderConfig: AiProviderConfigService
  /**
   * Runs a prompt on an editor selection and streams the replacement text.
   */
  readonly selectionTransform: SelectionTransformService
  /**
   * Creates the chat session of an open graph; the workspace owns the session.
   */
  readonly chatSessions: ChatSessionService
  /**
   * Lands the link captures spooled by the browser extension, the iOS share extension, Shortcuts and deep links in the daily note.
   */
  readonly capture: CaptureService
  /**
   * Segmented audio memos: saved raw, transcribed in the background, and linked from the daily note.
   */
  readonly audioMemo: AudioMemoService
  /**
   * Generates managed Markdown descriptions of eligible image and PDF assets, and folds them into search.
   */
  readonly assetDescription: AssetDescriptionService
  /**
   * Autocomplete candidates for `#` tags and `[[` wiki targets.
   */
  readonly suggestions: SuggestionService
  /**
   * The one retrieval contract that search and AI share.
   */
  readonly retrieval: RetrievalService
  /**
   * The mapping from email identities to `#person` notes.
   */
  readonly personNotes: PersonNoteService
  /**
   * The services that only a mobile platform builds; `null` elsewhere.
   */
  readonly mobile: MobileServices | null
}

/**
 * The mobile-only services that the app reads.
 */
export interface MobileServices {
  /**
   * The haptic engine.
   */
  readonly haptics: HapticsService
  /**
   * The current App Store subscription, seeded from the last launch.
   */
  readonly subscription: SubscriptionService
  /**
   * The App Store install channel, probed once per launch.
   */
  readonly appStoreEnvironment: AppStoreEnvironmentService
  /**
   * Whether the paywall replaces the app, and the actions that lift it.
   */
  readonly paywall: PaywallService
  /**
   * Native recording sessions end to end: start, stop and save, discard, and exactly-once ingest.
   */
  readonly mobileAudioMemo: MobileAudioMemoService
}

/**
 * The host primitives that {@link createCoreServices} builds the services on.
 */
export interface CoreAdapters {
  /**
   * The typed IPC bridge over the host's transport, shared with the app layer.
   */
  readonly ipc: IpcBridgeService
  /**
   * What the host is and can do, decided once at startup.
   */
  readonly platform: PlatformFacts
  /**
   * Which window this webview is: only the main window opens graphs and runs their indexer.
   */
  readonly role: GraphRole
  /**
   * Where business code reports visible background work.
   */
  readonly progress: ProgressPort
  /**
   * Outbound HTTP, in the shape of the global `fetch`.
   */
  readonly http: HttpService
  /**
   * The Web storage areas; `null` keeps an area in memory.
   */
  readonly storage: { readonly local: Storage | null; readonly session: Storage | null }
  /**
   * The native operations behind the path service.
   */
  readonly path: PathTransport
  /**
   * The app activity signals that business services follow.
   */
  readonly activity: ActivityPort
  readonly logger: LoggerService
  readonly clock: ClockService
  /**
   * Defaults to the system `IdService`.
   */
  readonly id?: IdService | undefined
  /**
   * Defaults to a codec that cannot decode.
   */
  readonly imageCodec?: ImageCodecService | undefined
  /**
   * Defaults to the URL shape of Apple webviews.
   */
  readonly convertFileSrc?: FileSrcConverter | undefined
  /**
   * The system's `reflect://` delivery; without one, no URL arrives.
   */
  readonly deepLink?: DeepLinkSource | undefined
  /**
   * Builds the graph-scoped services of a session that just opened, over
   * `deps`. They must dispose themselves when `session.signal` aborts.
   */
  readonly createGraphServices: (session: GraphSession, deps: GraphServicesDeps) => GraphServices
}

/**
 * The factory of every service {@link createCoreServices} builds, by key.
 */
export const coreServiceFactories = {
  database: createDatabaseService,
  settings: createSettingsService,
  storage: createWebStorageService,
  fileChanges: createFileChangeService,
  secretStore: createSecretStoreService,
  webAuth: createWebAuthService,
  classicAccess: createClassicAccessService,
  audioRecorder: createPlatformAudioRecorder,
  iap: createIapService,
  appStore: createAppStoreService,
  subscription: createSubscriptionService,
  appStoreEnvironment: createAppStoreEnvironmentService,
  haptics: createHapticsService,
  nativeAction: createNativeActionService,
  paywall: createPaywallService,
  mobileAudioMemo: createMobileAudioMemoService,
  noteFile: createNoteFileService,
  assetStore: createAssetStoreService,
  openDocuments: createOpenDocumentsService,
  indexQuery: createIndexQueryService,
  wikiResolver: createWikiResolverService,
  backlinks: createBacklinkService,
  search: createSearchService,
  suggestions: createSuggestionService,
  noteList: createNoteListService,
  graphStats: createGraphStatsService,
  notePath: createNotePathService,
  indexStore: createIndexStoreService,
  xArchive: createXArchiveService,
  aiCredentials: createAiCredentialService,
  aiKeyValidation: createAiKeyValidationService,
  languageModel: createLanguageModelService,
  aiProviderConfig: createAiProviderConfigService,
  noteLinkResolver: createNoteLinkResolverService,
  noteCreation: createNoteCreationService,
  privacy: createPrivacyService,
  calendar: createCalendarService,
  contacts: createContactsService,
  personNotes: createPersonNoteService,
  path: createPathService,
  mobileStorage: createMobileStorageService,
  noteDocuments: createNoteDocumentService,
  noteMove: createNoteMoveService,
  captureInbox: createCaptureInboxService,
  deepLinkIntake: createDeepLinkIntakeService,
  webFetch: createWebFetchService,
  pageDescriber: createPageDescriberService,
  reconcilers: createBackgroundReconcilerFactory,
  assetPrivacy: createAssetPrivacyService,
  assetDescriber: createAssetDescriberService,
  backlinkTarget: createBacklinkTargetService,
  indexLifecycle: createIndexLifecycleService,
  graphSession: createGraphSessionService<GraphServices>,
  attachments: createAttachmentService,
  persistenceFlush: createPersistenceFlushService,
  gitRepository: createGitRepositoryService,
  githubAuth: createGithubAuthService,
  githubRepos: createGithubRepoService,
  gists: createGistService,
  noteRows: createNoteRowService,
  syncEngines: createSyncEngineFactory,
  icloudNative: createICloudNativeService,
  embeddingRuntime: createEmbeddingRuntimeService,
  retrieval: createRetrievalService,
  embeddingIndex: createEmbeddingIndexService,
  transcription: createTranscriptionService,
  transcriptEnrichment: createTranscriptEnrichmentService,
  audioMemo: createAudioMemoService,
  chatHistory: createChatHistoryService,
  dailyNotes: createDailyNoteService,
  noteTools: createNoteToolsService,
  chatEngine: createChatEngineService,
  chatGraphContext: createChatGraphContextService,
  appInfo: createAppInfoService,
  contactSuggestions: createContactSuggestionService,
  meetings: createMeetingService,
  agentSkill: createAgentSkillService,
  gistPublish: createGistPublishService,
  icloudMigration: createICloudMigrationService,
  embedMedia: createEmbedMediaService,
  linkPreview: createLinkPreviewService,
  noteSessions: createNoteSessionService,
  titleRename: createTitleRenameService,
  notePreview: createNotePreviewService,
  tasks: createTaskService,
  noteActions: createNoteActionsService,
  templates: createTemplateService,
  semanticSearch: createSemanticSearchService,
  aiPrompts: createAiPromptService,
  selectionTransform: createSelectionTransformService,
  chatSessions: createChatSessionService,
  capture: createCaptureService,
  assetDescription: createAssetDescriptionService,
}

/**
 * The factory of each service key; a replacement gets the same dependencies.
 */
export type ServiceFactories = typeof coreServiceFactories

/**
 * The services that {@link createCoreServices} builds but keeps out of {@link CoreServices}.
 */
export interface CoreInternalServices {
  /**
   * Outbound HTTP, in the shape of the global `fetch`.
   */
  readonly http: HttpService
  /**
   * The OS keychain behind every credential.
   */
  readonly secretStore: SecretStoreService
  /**
   * Typed read-only queries over the active graph's SQLite index.
   */
  readonly database: DatabaseService
  /**
   * The SQLite projection of the active graph, written through the native `index_*` commands.
   */
  readonly indexStore: IndexStoreService
  /**
   * The Rust git primitives for the open graph's repository.
   */
  readonly gitRepository: GitRepositoryService
  /**
   * The backup repository on GitHub, over its REST API.
   */
  readonly githubRepos: GithubRepoService
  /**
   * The GitHub Gists REST surface behind "Publish to gist".
   */
  readonly gists: GistService
  /**
   * Builds the sync engine of one graph session.
   */
  readonly syncEngines: SyncEngineFactory
  /**
   * Bounded outbound web fetches that the native side performs.
   */
  readonly webFetch: WebFetchService
  /**
   * X (Twitter) posts and their media archived under `assets/x/`.
   */
  readonly xArchive: XArchiveService
  /**
   * The microphone recorder behind audio memos.
   */
  readonly audioRecorder: AudioRecorderService
  /**
   * The system web sign-in session.
   */
  readonly webAuth: WebAuthService
  /**
   * Binary files in the graph: attachments, audio memos, and the transcript cache.
   */
  readonly assetStore: AssetStoreService
  /**
   * Reads and writes Markdown notes by graph-relative path.
   */
  readonly noteFile: NoteFileService
  /**
   * Wiki-target resolution over the index's claims and keys.
   */
  readonly wikiResolver: WikiResolverService
  /**
   * Autocomplete candidates for `#` tags and `[[` wiki targets.
   */
  readonly suggestions: SuggestionService
  /**
   * Graph-level aggregates over the non-private notes.
   */
  readonly graphStats: GraphStatsService
  /**
   * The `private: true` gate that every outbound payload passes through.
   */
  readonly privacy: PrivacyService
  /**
   * Keeps each note's chunk vectors current.
   */
  readonly embeddingIndex: EmbeddingIndexService
  /**
   * The BYOK API key of each configured AI provider entry.
   */
  readonly aiCredentials: AiCredentialService
  /**
   * Checks a BYOK key with one cheap authenticated probe before it is saved.
   */
  readonly aiKeyValidation: AiKeyValidationService
  /**
   * Turns a configured BYOK entry and its key into a callable language model.
   */
  readonly languageModel: LanguageModelService
  /**
   * One multimodal call that cleans a captured page's title and describes the page.
   */
  readonly pageDescriber: PageDescriberService
  /**
   * One multimodal call that describes an image, PDF or SVG and transcribes its text.
   */
  readonly assetDescriber: AssetDescriberService
  /**
   * Speech to text for one recording.
   */
  readonly transcription: TranscriptionService
  /**
   * Best-effort formatting and titling of a transcript after transcription.
   */
  readonly transcriptEnrichment: TranscriptEnrichmentService
  /**
   * The read-only tools that the chat model can call, with the privacy gate inside.
   */
  readonly noteTools: NoteToolsService
  /**
   * Runs tool-grounded chat turns against the user's provider.
   */
  readonly chatEngine: ChatEngineService
  /**
   * Loads the graph overview that a chat turn's system prompt carries.
   */
  readonly chatGraphContext: ChatGraphContextService
  /**
   * The category notes that automatic backlinks point at.
   */
  readonly backlinkTarget: BacklinkTargetService
  /**
   * The verdict on whether an asset's bytes may be sent to a provider.
   */
  readonly assetPrivacy: AssetPrivacyService
  /**
   * The capture inbox of envelopes that the browser extension, the iOS share extension, and deep links spool.
   */
  readonly captureInbox: CaptureInboxService
}

export function createCoreServices(
  adapters: CoreAdapters,
  factories?: Partial<ServiceFactories>,
): CoreServices {
  return composeCoreServices(adapters, factories).services
}

/**
 * {@link createCoreServices}, plus the services it keeps internal.
 */
export function composeCoreServices(
  adapters: CoreAdapters,
  factories?: Partial<ServiceFactories>,
  options?: {
    /**
     * Builds the mobile services on every platform, so a test can reach them.
     */
    readonly alwaysBuildMobile?: boolean | undefined
  },
): { services: CoreServices; internal: CoreInternalServices } {
  const create: ServiceFactories = { ...coreServiceFactories, ...factories }
  const { logger, clock, ipc, activity } = adapters
  const database = create.database({ ipc })
  const platform = adapters.platform
  const fileSrc = { convertFileSrc: adapters.convertFileSrc ?? appleFileSrc }
  const progress = adapters.progress
  const settings = create.settings({ ipc, progress })
  const storage = create.storage({
    logger,
    localStorage: adapters.storage.local,
    sessionStorage: adapters.storage.session,
  })
  const fileChanges = create.fileChanges({
    ipc,
    logger,
    echoOwnWrites: isMobilePlatform(adapters.platform.appPlatform),
  })
  const id = adapters.id ?? createSystemIdService()
  const secretStore = create.secretStore({ ipc })
  // The desktop shell's web-auth plugin answers every sign-in as cancelled.
  const webAuth = create.webAuth({ ipc })
  const classicAccess = create.classicAccess({
    secretStore,
    http: adapters.http,
    webAuth,
    clock,
    id,
    activity,
    platform,
    logger,
  })
  const audioRecorder = create.audioRecorder({
    platform: adapters.platform,
    ipc,
    clock,
    logger,
  })
  const buildMobileServices = (): MobileServices => {
    const iap = create.iap({ ipc, logger })
    const appStore = create.appStore({ ipc })
    const subscription = create.subscription({ iap, storage, clock, platform, logger })
    const appStoreEnvironment = create.appStoreEnvironment({ appStore, storage, platform })
    const haptics = create.haptics({ ipc, logger })
    const nativeAction = create.nativeAction({ audioRecorder, clock, platform, logger })
    return {
      haptics,
      subscription,
      appStoreEnvironment,
      paywall: create.paywall({
        subscription,
        classicAccess,
        appStoreEnvironment,
        iap,
        appStore,
        platform,
        storage,
      }),
      mobileAudioMemo: create.mobileAudioMemo({
        audioMemo,
        audioRecorder,
        nativeAction,
        activity,
        haptics,
        platform,
        logger,
      }),
    }
  }
  const noteFile = create.noteFile({ ipc, clock, fileChanges })
  const assetStore = create.assetStore({ ipc, clock, fileChanges })
  const openDocuments = create.openDocuments({ fileChanges })
  // Read at call time: the graph session is built later.
  const lateGraphSession = { getState: () => graphSession.getState() }
  const indexQuery = create.indexQuery({ database })
  const wikiResolver = create.wikiResolver({ database })
  const backlinks = create.backlinks({ database, noteFile, graphSession: lateGraphSession })
  const search = create.search({ database, wikiResolver })
  const suggestions = create.suggestions({ database })
  const noteList = create.noteList({ database })
  const graphStats = create.graphStats({ database })
  const notePath = create.notePath({ database, noteFile })
  const indexStore = create.indexStore({ ipc, database })
  const xArchive = create.xArchive({ ipc })
  const aiCredentials = create.aiCredentials({ secretStore })
  const aiKeyValidation = create.aiKeyValidation({ http: adapters.http })
  const languageModel = create.languageModel({ http: adapters.http, sdk: createLazyAiSdkLoader() })
  const aiProviderConfig = create.aiProviderConfig({
    settings,
    credentials: aiCredentials,
    keyValidation: aiKeyValidation,
    id,
  })
  const noteLinkResolver = create.noteLinkResolver({ wikiResolver, noteFile })
  const noteCreation = create.noteCreation({ noteFile, noteLinkResolver, id })
  const privacy = create.privacy({ noteFile, graphSession: lateGraphSession })
  const calendar = create.calendar({ ipc, logger })
  const contacts = create.contacts({ ipc, logger })
  const personNotes = create.personNotes({
    database,
    wikiResolver,
    noteCreation,
  })
  const path = create.path({ transport: adapters.path })
  const mobileStorage = create.mobileStorage({ ipc })
  const noteDocuments = create.noteDocuments({
    openDocuments,
    noteFile,
    // Read at call time: the graph session is built later.
    graphSession: { getState: () => graphSession.getState() },
  })
  const noteMove = create.noteMove({ ipc, indexStore, openDocuments, logger })
  const captureInbox = create.captureInbox({ ipc })
  const webFetch = create.webFetch({ ipc })
  const pageDescriber = create.pageDescriber({ languageModel })
  const reconcilers = create.reconcilers({ activity })
  const assetPrivacy = create.assetPrivacy({
    noteFile,
    xArchive,
    assetReferences: createAssetReferences({ database, xArchive }),
  })
  const assetDescriber = create.assetDescriber({ languageModel })
  const backlinkTarget = create.backlinkTarget({
    noteCreation,
    noteFile,
  })
  const indexLifecycle = create.indexLifecycle({
    indexStore,
    noteFile,
    fileChanges,
    indexQuery,
    database,
    xArchive,
    clock,
    logger,
    progress,
    // Read at call time: the graph session is built on this lifecycle.
    graphSession: {
      getState: () => graphSession.getState(),
      subscribe: (listener) => graphSession.subscribe(listener),
    },
    activity,
    platform,
    role: adapters.role,
  })
  const noteRows = create.noteRows({
    // Read at call time: the graph session is built on these rows.
    graphSession: {
      getState: () => graphSession.getState(),
      subscribe: (listener) => graphSession.subscribe(listener),
    },
  })
  const icloudNative = create.icloudNative({ ipc, logger })
  const graphSession = create.graphSession({
    ipc,
    indexLifecycle,
    indexStore,
    noteFile,
    id,
    fileChanges,
    role: adapters.role,
    mobileStorage,
    noteRows,
    openDocuments,
    noteMove,
    icloudNative,
    logger,
    createServices: (session) => {
      return adapters.createGraphServices(session, {
        gitSync: gitSyncDeps,
        icloudSync: icloudSyncDeps,
        icloudDownload: icloudDownloadDeps,
        capture: services.capture,
        assetDescription: services.assetDescription,
        chatSessions: services.chatSessions,
        attachments,
        graphSession,
      })
    },
  })
  const attachments = create.attachments({
    assetStore,
    noteFile,
    fileChanges,
    progress,
    clock,
    platform: fileSrc,
    graphSession,
  })
  const persistenceFlush = create.persistenceFlush({
    settings,
    openDocuments,
    logger,
  })
  const gitRepository = create.gitRepository({ ipc })
  const githubAuth = create.githubAuth({ secretStore, http: adapters.http, clock })
  const githubRepos = create.githubRepos({ http: adapters.http })
  const gists = create.gists({ http: adapters.http })
  const syncEngines = create.syncEngines({ git: gitRepository, clock })
  const embeddingRuntime = create.embeddingRuntime({ ipc, logger })
  const retrieval = create.retrieval({
    database,
    search,
    embeddingRuntime,
    logger,
  })
  const embeddingIndex = create.embeddingIndex({
    ipc,
    embeddingRuntime,
    noteFile,
    database,
    indexLifecycle,
    logger,
    clock,
  })
  const transcription = create.transcription({ http: adapters.http })
  const transcriptEnrichment = create.transcriptEnrichment({ languageModel })
  const audioMemo = create.audioMemo({
    assetStore,
    noteFile,
    backlinkTarget,
    transcription,
    transcriptEnrichment,
    aiProviderConfig,
    aiCredentials,
    audioRecorder,
    reconcilers,
    activity,
    fileChanges,
    settings,
    progress,
    clock,
    platform,
    role: adapters.role,
    graphSession,
    logger,
  })
  const mobile =
    options?.alwaysBuildMobile === true ||
    isMobilePlatform(platform.appPlatform) ||
    platform.surface.mobileApp
      ? buildMobileServices()
      : null
  const chatHistory = create.chatHistory({ ipc, database, logger })
  const dailyNotes = create.dailyNotes({ database, clock, activity })
  const noteTools = create.noteTools({
    retrieval,
    noteFile,
    noteList,
    dailyNotes,
    assetReferences: createAssetReferences({ database, xArchive }),
    assetPrivacy,
    xArchive,
    privacy,
  })
  const chatEngine = create.chatEngine({
    logger,
    languageModel,
    noteTools,
    fitToContextWindow,
  })
  const chatGraphContext = create.chatGraphContext({
    graphStats,
    privacy,
  })
  const imageCodec = adapters.imageCodec ?? createUnavailableImageCodec()
  const gitSyncDeps: GitSyncServiceDeps = {
    git: gitRepository,
    syncEngines,
    githubAuth,
    githubRepos,
    fileChanges,
    indexLifecycle,
    progress,
    clock,
    activity,
    platform,
    persistenceFlush,
    logger,
    icloudNative,
  }
  const icloudSyncDeps: ICloudSyncServiceDeps = {
    icloudNative,
    fileChanges,
    indexLifecycle,
    openDocuments,
    activity,
    clock,
    logger,
    progress,
  }
  const icloudDownloadDeps: ICloudDownloadServiceDeps = { icloudNative, activity, clock, logger }
  const services: CoreServices = {
    ipc,
    logger,
    clock,
    id,
    platform,
    storage,
    path,
    appInfo: create.appInfo({ ipc }),
    calendar,
    contacts,
    contactSuggestions: create.contactSuggestions({
      contacts,
      noteDocuments,
      openDocuments,
      noteFile,
      settings,
      graphSession,
      logger,
    }),
    meetings: create.meetings({
      noteFile,
      noteCreation,
      wikiResolver,
      suggestions,
      personNotes,
      contacts,
      settings,
      logger,
      graphSession,
    }),
    agentSkill: create.agentSkill({ ipc, graphSession }),
    mobileStorage,
    imageCodec,
    settings,
    persistenceFlush,
    embeddingRuntime,
    chatHistory,
    deepLinkIntake: create.deepLinkIntake({
      source: adapters.deepLink ?? createNoDeepLinkSource(),
      indexQuery,
      captureInbox,
      progress,
      id,
      clock,
      graphSession,
    }),
    wikiResolver,
    noteLinkResolver,
    githubAuth,
    gistPublish: create.gistPublish({
      gists,
      githubAuth,
      noteDocuments,
      noteRows,
      privacy,
      progress,
      graphSession,
    }),
    icloudNative,
    icloudMigration: create.icloudMigration({ icloudNative, graphSession }),
    embedMedia: create.embedMedia({
      xArchive,
      webFetch,
      platform: fileSrc,
      clock,
      logger,
      graphSession,
    }),
    linkPreview: create.linkPreview({
      noteDocuments,
      privacy,
      webFetch,
      parseMetadata: parseLinkPreviewMeta,
      graphSession,
    }),
    classicAccess,
    fileChanges,
    attachments,
    noteSessions: create.noteSessions({
      noteFile,
      clock,
      logger,
      graphSession,
    }),
    openDocuments,
    noteMove,
    titleRename: create.titleRename({
      noteFile,
      wikiResolver,
      backlinks,
      notePath,
      noteMove,
      openDocuments,
      progress,
      clock,
      logger,
      graphSession,
    }),
    noteDocuments,
    notePreview: create.notePreview({
      noteLinkResolver,
      noteDocuments,
      attachments,
      graphSession,
    }),
    tasks: create.tasks({
      database,
      noteDocuments,
      progress,
      clock,
      logger,
      graphSession,
      indexLifecycle,
      role: adapters.role,
      ipc,
    }),
    noteActions: create.noteActions({
      noteDocuments,
      noteFile,
      openDocuments,
      indexLifecycle,
      indexQuery,
      noteRows,
      progress,
      path,
      id,
      graphSession,
    }),
    noteRows,
    dailyNotes,
    templates: create.templates({
      noteFile,
      indexQuery,
      notePath,
      noteMove,
      openDocuments,
      progress,
      graphSession,
    }),
    indexQuery,
    backlinks,
    search,
    noteList,
    notePath,
    noteCreation,
    indexLifecycle,
    graphSession,
    semanticSearch: create.semanticSearch({
      embeddingRuntime,
      embeddingIndex,
      retrieval,
      settings,
      storage,
      role: adapters.role,
      indexLifecycle,
      graphSession,
      logger,
    }),
    aiPrompts: create.aiPrompts({ settings, id }),
    aiProviderConfig,
    selectionTransform: create.selectionTransform({
      logger,
      languageModel,
      providerConfig: aiProviderConfig,
      credentials: aiCredentials,
      privacy,
    }),
    chatSessions: create.chatSessions({
      chatEngine,
      chatHistory,
      chatGraphContext,
      providerConfig: aiProviderConfig,
      credentials: aiCredentials,
      embeddingRuntime,
      settings,
      clock,
      id,
      imageCodec,
      logger,
    }),
    capture: create.capture({
      captureInbox,
      noteFile,
      assetStore,
      openDocuments,
      backlinkTarget,
      xArchive,
      webFetch,
      pageDescriber,
      aiProviderConfig,
      aiCredentials,
      privacy,
      clock,
      reconcilers,
      activity,
      fileChanges,
      progress,
      platform,
      logger,
    }),
    audioMemo,
    assetDescription: create.assetDescription({
      assetStore,
      noteFile,
      assetPrivacy,
      assetDescriber,
      aiProviderConfig,
      aiCredentials,
      clock,
      reconcilers,
      indexLifecycle,
      progress,
      graphSession,
      logger,
    }),
    personNotes,
    suggestions,
    retrieval,
    mobile,
  }
  const internal: CoreInternalServices = {
    http: adapters.http,
    secretStore,
    database,
    indexStore,
    gitRepository,
    githubRepos,
    gists,
    syncEngines,
    webFetch,
    xArchive,
    audioRecorder,
    webAuth,
    assetStore,
    noteFile,
    wikiResolver,
    suggestions,
    graphStats,
    privacy,
    embeddingIndex,
    aiCredentials,
    aiKeyValidation,
    languageModel,
    pageDescriber,
    assetDescriber,
    transcription,
    transcriptEnrichment,
    noteTools,
    chatEngine,
    chatGraphContext,
    backlinkTarget,
    assetPrivacy,
    captureInbox,
  }
  return { services, internal }
}
