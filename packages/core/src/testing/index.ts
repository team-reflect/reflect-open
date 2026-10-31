/**
 * Test doubles for `@reflect/core` services. Each `createTestXxxService()`
 * returns an in-memory implementation of the matching service interface plus
 * observation helpers. Apps import this module in tests only.
 */
export { createTestIdService, type TestIdService } from './id.ts'
export { createTestLoggerService, type LogEntry, type TestLoggerService } from './logger.ts'
export { createTestClockService, type TestClockService } from './clock.ts'
export {
  createTestIpcBridgeService,
  type TestIpcBridgeService,
  type TestIpcBridgeServiceOptions,
} from './ipc.ts'
export {
  createTestActivityPort,
  type TestActivityPort,
  type TestActivityPortOptions,
} from './shell.ts'
export {
  createTestPlatformService,
  type TestPlatformOptions,
  type TestPlatformService,
} from './platform.ts'
export {
  createTestHttpService,
  type TestHttpHandler,
  type TestHttpMatcher,
  type TestHttpReply,
  type TestHttpRequest,
  type TestHttpRoute,
  type TestHttpService,
} from './http.ts'
export { createTestStorageService, type TestStorageService } from './storage.ts'
export type { CoreInternalServices } from '../create-core-services.ts'
export {
  createTestCoreServices,
  type TestCoreServiceOverrides,
  type TestCoreServices,
  type TestMobileServices,
} from './services.ts'
export {
  createTestCalendarService,
  type TestCalendarService,
  type TestCalendarServiceOptions,
} from './calendar.ts'
export {
  createTestContactsService,
  type ContactsLookup,
  type TestContactsService,
  type TestContactsServiceOptions,
} from './contacts.ts'
export {
  createNodeTestDatabaseService,
  seedNotes,
  type TestDatabaseQuery,
  type TestDatabaseService,
  type TestNote,
} from './database.ts'
export {
  createTestEmbeddingIndexService,
  createTestEmbeddingRuntimeService,
  createTestRetrievalService,
  createTestSemanticSearchService,
  type TestEmbeddingApply,
  type TestEmbeddingIndexService,
  type TestEmbeddingIndexServiceOptions,
  type TestEmbeddingRemove,
  type TestEmbeddingRuntimeService,
  type TestEmbeddingRuntimeServiceOptions,
  type TestRetrievalService,
  type TestRetrievalServiceOptions,
  type TestSemanticSearchService,
  type TestSemanticSearchServiceOptions,
} from './embeddings.ts'
export {
  createTestChatEngineService,
  createTestChatGraphContextService,
  createTestChatHistoryService,
  type TestChatConversation,
  type TestChatEngineService,
  type TestChatGraphContextService,
  type TestChatGraphContextSource,
  type TestChatHistoryService,
  type TestChatHistoryServiceOptions,
  type TestChatTurnScript,
} from './chat.ts'
export {
  createTestMobileStorageService,
  type TestMobileStorageService,
  type TestMobileStorageServiceOptions,
} from './mobile-storage.ts'
export {
  createTestImageCodec,
  type TestImageCodecService,
  type TestImageEncode,
  type TestImageSize,
} from './image-codec.ts'
export {
  createTestAssetReferences,
  trackAssetDescriptionSessions,
  type TestAssetReferences,
} from './assets.ts'
export {
  createTestCaptureInboxService,
  createTestCaptureService,
  createTestWebFetchService,
  createTestXArchiveService,
  type TestCaptureInboxService,
  type TestCaptureService,
  type TestCaptureSessionState,
  type TestWebFetchService,
  type TestXArchiveService,
  type WebFetchKind,
} from './capture.ts'
export {
  createTestDeepLinkIntakeService,
  createTestDeepLinkSource,
  type TestDeepLinkIntakeService,
  type TestDeepLinkIntakeServiceOptions,
  type TestDeepLinkSource,
} from './deep-link.ts'
export {
  createTestGitSyncService,
  createTestGithubConnector,
  createTestGitHostConnector,
  createTestGitRepositoryService,
  createTestGithubAuthService,
  createTestICloudNativeService,
  createTestICloudSyncService,
  type GitSyncCall,
  type GithubConnectorCall,
  type GitHostConnectorCall,
  type TestGithubConnector,
  type TestGitHostConnector,
  type GitRepositoryCall,
  type GitRepositoryHandler,
  type ICloudNativeCall,
  type TestGitSyncService,
  type TestGitRepositoryService,
  type TestGithubAuthOptions,
  type TestGithubAuthService,
  type TestICloudNativeService,
  type TestICloudSyncService,
} from './sync.ts'
export {
  createTestAiKeyValidationService,
  createTestAssetDescriberService,
  createTestPageDescriberService,
  createTestTranscriptionService,
  createTestLanguageModelService,
  type TestAiKeyValidationService,
  type TestAssetDescriberService,
  type TestAssetDescriberSource,
  type TestPageDescriberService,
  type TestPageDescriberSource,
  type TestTranscriptionService,
  type TestTranscriptionSource,
  type TestLanguageModelCall,
  type TestLanguageModelService,
  type TestLanguageModelSource,
} from './ai.ts'
export {
  createTestAppInfoService,
  createTestSecretStoreService,
  type TestSecretStoreService,
} from './secrets.ts'
export {
  createTestIndexStoreService,
  type IndexStoreCall,
  type TestIndexStoreService,
  type TestIndexStoreServiceOptions,
} from './index-store.ts'
export {
  createTestGraphSessionService,
  type TestGraphSessionService,
  type TestGraphSessionServiceOptions,
  type TestOpenGraph,
} from './graph-session.ts'
export {
  createTestIndexLifecycleService,
  type TestIndexLifecycleService,
  type TestIndexLifecycleServiceOptions,
} from './index-lifecycle.ts'
export {
  createTestProgressPort,
  type ProgressSnapshot,
  type StartedOperation,
  type TestProgressPort,
} from './ports.ts'
export { createTestSettingsService, type TestSettingsService } from './settings.ts'
export {
  createTestPersistenceFlushService,
  type TestPersistenceFlushService,
} from './persistence-flush.ts'
export {
  createTestFileChangeService,
  type TestFileChangeService,
  type TestFileChangeServiceOptions,
} from './file-change.ts'
export {
  createTestAppStoreService,
  createTestHapticsService,
  createTestIapService,
  createTestWebAuthService,
  type AppStoreCall,
  type TestAppStoreService,
  type TestHapticsService,
  type TestIapService,
  type TestWebAuthService,
} from './plugins.ts'
export {
  createTestAudioRecorderService,
  type AudioRecorderCall,
  type TestAudioRecorderService,
} from './audio-recorder.ts'
export {
  createTestAssetStoreService,
  createTestNoteCreationService,
  createTestNoteFileService,
  createTestNoteLinkResolverService,
  type AssetUpload,
  type NoteFileRead,
  type NoteFileWrite,
  type NoteLinkResolution,
  type TestAssetStoreService,
  type TestAssetStoreServiceOptions,
  type TestNoteCreationService,
  type TestNoteCreationServiceOptions,
  type TestNoteFileService,
  type TestNoteFileServiceOptions,
  type TestNoteLinkResolverService,
  type TestNoteLinkResolverServiceOptions,
} from './graph.ts'
export {
  createTestAttachmentService,
  type AttachmentSave,
  type TestAttachmentEntry,
  type TestAttachmentService,
  type TestAttachmentServiceOptions,
} from './attachments.ts'
export { makeOpenTask } from './tasks.ts'
export {
  createTestNoteSession,
  type NoteSessionCall,
  type TestNoteSession,
  type TestNoteSessionOptions,
  createTestNoteMoveService,
  type TestNoteMoveService,
} from './documents.ts'
export {
  createTestAppStoreEnvironmentService,
  createTestClassicAccessService,
  createTestSubscriptionService,
  type AppStoreEnvironmentCall,
  type ClassicAccessCall,
  type SubscriptionCall,
  type TestAppStoreEnvironmentService,
  type TestClassicAccessService,
  type TestSubscriptionService,
} from './monetization.ts'
