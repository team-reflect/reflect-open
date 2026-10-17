import { vi, type Mock, type MockInstance } from 'vitest'
import { audioMemoIdentity } from './audio-memo.ts'
import { aiKeySecretName, createAiCredentialService } from '../ai/ai-credential-service.ts'
import { createAiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import type { AiProvidersState } from '../ai/provider-config.ts'
import {
  createTranscriptEnrichmentService,
  type TranscriptEnrichmentService,
} from '../ai/transcript-enrichment-service.ts'
import { createBackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import type { BacklinkTargetService } from '../capture/backlink-target-service.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import type { SecretStoreService } from '../secrets/secret-store-service.ts'
import {
  createTestAiKeyValidationService,
  createTestIdService,
  createTestAssetStoreService,
  createTestLanguageModelService,
  createTestClockService,
  createTestFileChangeService,
  createTestActivityPort,
  createTestNoteFileService,
  createTestProgressPort,
  createTestSecretStoreService,
  createTestSettingsService,
  createTestTranscriptionService,
  type TestAssetStoreService,
  type TestClockService,
  type TestFileChangeService,
  type TestActivityPort,
  type TestNoteFileService,
  type TestProgressPort,
  type TestSecretStoreService,
  type TestSettingsService,
  type TestTranscriptionService,
} from '../testing/index.ts'
import {
  createAudioMemoTranscriptionService,
  type AudioMemoTranscriptionService,
  type ReconcileAudioMemosInput,
  type ReconcileAudioMemosOutcome,
} from './audio-memo-transcription-service.ts'

/**
 * Shared setup for the audio memo transcription tests: the transcription
 * service over one set of in-memory services, with a configured OpenAI entry
 * and its key unless overridden.
 */

export const OPENAI_CONFIG = {
  id: 'cfg-openai',
  provider: 'openai',
  model: 'gpt-5.1',
  keyHint: 'wxyz1',
} as const

export const ANTHROPIC_CONFIG = {
  id: 'cfg-anthropic',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  keyHint: 'wxyz1',
} as const

export const PROVIDERS: AiProvidersState = {
  providers: [OPENAI_CONFIG],
  defaultProviderId: 'cfg-openai',
}
export const NO_PROVIDERS: AiProvidersState = { providers: [], defaultProviderId: null }

export const OPENAI_KEY = aiKeySecretName('cfg-openai')
export const ANTHROPIC_KEY = aiKeySecretName('cfg-anthropic')

/**
 * 2026-06-11 15:30:22.845 local — every derived name is asserted from it.
 */
export const RECORDED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
export const MEMO = audioMemoIdentity(RECORDED_AT, 'audio/webm;codecs=opus')
export const DAILY = 'daily/2026-06-11.md'

export interface AudioMemoTestKitOptions {
  providers?: AiProvidersState
}

export interface AudioMemoTestKit {
  /**
   * The in-memory graph: notes, and the listing of `audio-memos/`.
   */
  noteFile: TestNoteFileService
  /**
   * The recordings' bytes and the transcript cache.
   */
  assetStore: TestAssetStoreService
  secrets: TestSecretStoreService
  settings: TestSettingsService
  transcription: TestTranscriptionService
  progress: TestProgressPort
  activity: TestActivityPort
  fileChanges: TestFileChangeService
  clock: TestClockService
  getSecretMock: MockInstance<SecretStoreService['get']>
  readBytesMock: MockInstance<AssetStoreService['readBytes']>
  readTranscriptCacheMock: MockInstance<AssetStoreService['readTranscriptCache']>
  enrichMock: Mock<TranscriptEnrichmentService['enrich']>
  ensureBacklinkTargetMock: Mock<BacklinkTargetService['ensure']>
  service: AudioMemoTranscriptionService
  /**
   * Put a recording into `audio-memos/`, with the bytes `audio-bytes`.
   */
  addRecording(path: string, options?: { modifiedMs?: number }): void
  /**
   * Run one pass at generation 3, without formatting or a hint unless overridden.
   */
  reconcile(overrides?: Partial<ReconcileAudioMemosInput>): Promise<ReconcileAudioMemosOutcome>
}

/**
 * Fresh in-memory services with the transcription service built on them.
 */
export async function createAudioMemoTestKit(
  options?: AudioMemoTestKitOptions,
): Promise<AudioMemoTestKit> {
  const providers = options?.providers ?? PROVIDERS
  const noteFile = createTestNoteFileService({ files: { [DAILY]: 'morning thoughts\n' } })
  const assets = new Map<string, string>()
  const assetStore = createTestAssetStoreService()
  const secrets = createTestSecretStoreService({
    [OPENAI_KEY]: 'sk-live-key',
    [ANTHROPIC_KEY]: 'sk-live-key',
  })
  const getSecretMock = vi.spyOn(secrets, 'get')
  const settings = createTestSettingsService({
    aiProviders: providers.providers,
    defaultAiProviderId: providers.defaultProviderId,
  })
  await settings.whenLoaded()
  const aiCredentials = createAiCredentialService({ secretStore: secrets })
  const transcription = createTestTranscriptionService('memo transcript')
  const enrichMock = vi
    .fn<TranscriptEnrichmentService['enrich']>()
    .mockImplementation((input) =>
      Promise.resolve({ title: 'Memo Transcript', body: input.transcript }),
    )
  const transcriptEnrichment = createTranscriptEnrichmentService({
    languageModel: createTestLanguageModelService(),
  })
  vi.spyOn(transcriptEnrichment, 'enrich').mockImplementation(enrichMock)
  const ensureBacklinkTargetMock = vi
    .fn<BacklinkTargetService['ensure']>()
    .mockResolvedValue('Audio memos')
  const clock = createTestClockService({ now: Date.now() })
  const progress = createTestProgressPort()
  const activity = createTestActivityPort()
  const fileChanges = createTestFileChangeService()
  const readBytesMock = vi
    .spyOn(assetStore, 'readBytes')
    .mockImplementation((path) => new TextEncoder().encode(assets.get(path) ?? ''))

  const service = createAudioMemoTranscriptionService({
    noteFile,
    assetStore,
    backlinkTarget: { ensure: ensureBacklinkTargetMock },
    transcription,
    transcriptEnrichment,
    aiProviderConfig: createAiProviderConfigService({
      settings,
      credentials: aiCredentials,
      keyValidation: createTestAiKeyValidationService(),
      id: createTestIdService(),
    }),
    aiCredentials,
    settings,
    reconcilers: createBackgroundReconcilerFactory({ activity }),
    activity,
    fileChanges,
    progress,
    clock,
  })

  return {
    noteFile,
    assetStore,
    secrets,
    settings,
    transcription,
    progress,
    activity,
    fileChanges,
    clock,
    getSecretMock,
    readBytesMock,
    readTranscriptCacheMock: vi.spyOn(assetStore, 'readTranscriptCache'),
    enrichMock,
    ensureBacklinkTargetMock,
    service,
    addRecording(path, recordingOptions) {
      // One byte in the listing: an empty file is an end marker, never sent.
      noteFile.set(path, 'x', { modifiedMs: recordingOptions?.modifiedMs ?? 0 })
      assets.set(path, 'audio-bytes')
    },
    reconcile: (overrides = {}) =>
      service.reconcile({
        generation: 3,
        formatTranscript: false,
        transcriptionPrompt: '',
        ...overrides,
      }),
  }
}
