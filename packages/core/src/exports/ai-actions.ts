export {
  AI_PROVIDERS,
  aiProvider,
  aiModelLabel,
  DEFAULT_CONTEXT_WINDOW,
  modelContextWindow,
  type AiProviderInfo,
  type AiModelOption,
} from '../ai/provider-catalog'
export { aiKeySecretName } from '../ai/secrets'
export { setSecret, getSecret, deleteSecret } from '../secrets/keychain'
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
} from '../ai/provider-config'
export {
  chatModelOptions,
  resolveChatModel,
  type ChatModelOption,
  type ChatModelSelection,
} from '../ai/chat/model-options'
export { validateApiKey, type ApiKeyValidation } from '../ai/validate-key'
export {
  assertCloudAllowed,
  cloudSafeAssetDescription,
  cloudSafeGraphContext,
  cloudSafeNoteContent,
  cloudSafeNoteListings,
  cloudSafeSearchHits,
  cloudSafeSelection,
  isPrivateNoteError,
  PrivateNoteError,
  type CloudAssetDescription,
  type CloudGraphContext,
  type CloudNoteContent,
  type CloudNoteListing,
  type CloudSafe,
  type CloudSearchHit,
  type CloudSendable,
} from '../ai/checkers'
export {
  buildNoteTools,
  MAX_DAILY_NOTE_DAYS,
  type ListDailyNotesOutput,
  type ListRecentNotesOutput,
  type NoteHitSummary,
  type NoteToolCall,
  type NoteToolDeps,
  type NoteToolResult,
  type NoteTools,
  type ReadAssetSummary,
  type ReadNoteSummary,
  type SearchNotesOutput,
} from '../ai/chat/tools'
export {
  MAX_NOTE_CONTENT_CHARS,
  MAX_READ_NOTES,
  type ReadNoteResult,
  type ReadNotesOutput,
} from '../ai/chat/read-notes'
export {
  MAX_ASSET_DESCRIPTION_CHARS,
  MAX_READ_ASSETS,
  type ReadAssetResult,
  type ReadAssetsOutput,
} from '../ai/chat/read-assets'
export { chatSystemPrompt, type SystemPromptInput } from '../ai/chat/system-prompt'
export {
  loadChatGraphContext,
  MAX_CONTEXT_TAGS,
  type GraphContextDeps,
} from '../ai/chat/graph-context'
export {
  streamChat,
  type ChatStreamEvent,
  type StreamChatOptions,
} from '../ai/chat/stream-chat'
export {
  BUILT_IN_AI_PROMPTS,
  filterAiPrompts,
  renderSelectionPrompt,
} from '../ai/selection-prompts'
export {
  transformSelection,
  type TransformSelectionOptions,
  type TransformStreamEvent,
} from '../ai/transform-selection'
export {
  appendEvent,
  buildHistory,
  isToolPending,
  NO_REPLY_NOTICE,
  userMessage,
  type AssistantPart,
  type ChatAttachment,
  type ChatTurn,
} from '../ai/chat/transcript'
export {
  deleteChatConversation,
  listChatConversations,
  loadChatMessages,
  saveChatMessage,
  type ChatConversation,
} from '../ai/chat/store'
export {
  estimateTokens,
  fitToContextWindow,
  type ContextWindowOptions,
} from '../ai/chat/context-window'
export type { ModelMessage as ChatModelMessage } from 'ai'
export {
  isTranscriptionRejected,
  transcribeAudio,
  TranscriptionRejectedError,
  type TranscriptionRequest,
} from '../ai/transcribe'
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
} from '../actions/audio-memo'
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
} from '../actions/capture-envelope'
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
} from '../actions/capture'
export { parsePageMeta, scrapePageMeta, type PageMeta } from '../actions/meta-scrape'
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
} from '../calendar/commands'
export {
  displayEvents,
  isDeclinedByUser,
  defaultAttendees,
  dayRange,
} from '../calendar/events'
export {
  addMeetingToDaily,
  meetingLine,
  MEETINGS_HEADING,
  type AddMeetingInput,
  type AddMeetingOutcome,
  type MeetingAttendee,
} from '../actions/add-meeting'
export { resolveMeetingAttendees } from '../actions/resolve-attendees'
export {
  describePage,
  isDescriptionRejected,
  DescriptionRejectedError,
  type DescribePageRequest,
} from '../ai/describe-page'
export {
  isAssetDescriptionRejected,
  AssetDescriptionRejectedError,
  type AssetKind,
  type DescribeAssetRequest,
} from '../ai/describe-asset'
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
} from '../actions/asset-description'
