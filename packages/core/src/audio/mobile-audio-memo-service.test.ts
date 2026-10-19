import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { audioMemoIdentity, audioMemoPartPath } from './audio-memo.ts'
import type { AiProvidersState } from '../ai/provider-config.ts'
import { AUDIO_MEMOS_DIR } from '../graph/paths.ts'
import { createAiCredentialService } from '../ai/ai-credential-service.ts'
import { createAiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import { createTranscriptEnrichmentService } from '../ai/transcript-enrichment-service.ts'
import { createBackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import { createBacklinkTargetService } from '../capture/backlink-target-service.ts'
import { createAudioMemoService } from './audio-memo-service.ts'
import { createMobileAudioMemoService } from './mobile-audio-memo-service.ts'
import { createNativeActionService } from './native-action-service.ts'
import {
  createTestAiKeyValidationService,
  createTestAssetStoreService,
  createTestAudioRecorderService,
  createTestClockService,
  createTestFileChangeService,
  createTestGraphSessionService,
  createTestHapticsService,
  createTestIdService,
  createTestLanguageModelService,
  createTestActivityPort,
  createTestLoggerService,
  createTestNoteCreationService,
  createTestNoteFileService,
  createTestProgressPort,
  createTestPlatformService,
  createTestSecretStoreService,
  createTestSettingsService,
  createTestTranscriptionService,
} from '../testing/index.ts'
import type {
  AudioRecorderFinalSegment,
  AudioRecorderSegment,
  StagedRecordingFile,
} from './audio-recorder-service.ts'

const PROVIDERS: AiProvidersState = {
  providers: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.1', keyHint: 'wxyz1' }],
  defaultProviderId: 'cfg-openai',
}
/**
 * Configured, but with no model that can transcribe.
 */
const ANTHROPIC_ONLY: AiProvidersState = {
  providers: [{ id: 'claude', provider: 'anthropic', model: 'claude-fable-5', keyHint: 'wxyz1' }],
  defaultProviderId: 'claude',
}

const SESSION_STARTED_MS = 1_700_000_000_000
const MEMO = audioMemoIdentity(new Date(SESSION_STARTED_MS), 'audio/mp4')

const FINAL_STAGED = '/staging/recording-1700000000000.part-001-end.m4a'
const ROTATED_STAGED = '/staging/recording-1700000000000.part-001.m4a'
const STRAGGLER_STAGED = '/staging/recording-1700000000000.part-002.m4a'
const ORPHAN_STAGED = '/staging/recording-1700000050000.part-001-end.m4a'
const CLAIMED_STAGED = '/staging/recording-claimed.part-001.m4a'

const RECORDING: AudioRecorderFinalSegment = {
  audio: { kind: 'staged', path: FINAL_STAGED },
  mimeType: 'audio/mp4',
  sessionStartedMs: SESSION_STARTED_MS,
  part: 1,
  end: true,
  durationMs: 4000,
}

const ROTATED: AudioRecorderSegment = {
  audio: { kind: 'staged', path: ROTATED_STAGED },
  mimeType: 'audio/mp4',
  sessionStartedMs: SESSION_STARTED_MS,
  part: 1,
  end: false,
}

function stagedFile(path: string, sessionStartedMs: number, end: boolean): StagedRecordingFile {
  return { path, sessionStartedMs, part: 1, end, modifiedMs: sessionStartedMs }
}

interface SetupOptions {
  providers?: AiProvidersState
  isNativeShell?: boolean
}

async function setup(options?: SetupOptions) {
  const providers = options?.providers ?? PROVIDERS
  const settings = createTestSettingsService({
    aiProviders: providers.providers,
    defaultAiProviderId: providers.defaultProviderId,
  })
  await settings.whenLoaded()
  const noteFile = createTestNoteFileService()
  const assetStore = createTestAssetStoreService({
    sources: {
      [FINAL_STAGED]: 'final',
      [ROTATED_STAGED]: 'rotated',
      [STRAGGLER_STAGED]: 'straggler',
      [ORPHAN_STAGED]: 'orphan',
      [CLAIMED_STAGED]: 'claimed',
    },
  })
  const recorder = createTestAudioRecorderService({ sessionStartedMs: SESSION_STARTED_MS })
  recorder.setStopResult(RECORDING)
  const activity = createTestActivityPort()
  const haptics = createTestHapticsService()
  const progress = createTestProgressPort()
  const logger = createTestLoggerService()
  const clock = createTestClockService()
  const platform = createTestPlatformService({
    appPlatform: 'ios',
    isNativeShell: options?.isNativeShell ?? true,
  })
  const listDirMock = vi.spyOn(noteFile, 'listDir')
  const aiCredentials = createAiCredentialService({ secretStore: createTestSecretStoreService() })
  const audioMemo = createAudioMemoService({
    assetStore,
    noteFile,
    backlinkTarget: createBacklinkTargetService({
      noteFile,
      noteCreation: createTestNoteCreationService({ noteFile }),
    }),
    transcription: createTestTranscriptionService(),
    transcriptEnrichment: createTranscriptEnrichmentService({
      languageModel: createTestLanguageModelService(),
    }),
    aiProviderConfig: createAiProviderConfigService({
      settings,
      credentials: aiCredentials,
      keyValidation: createTestAiKeyValidationService(),
      id: createTestIdService(),
    }),
    aiCredentials,
    audioRecorder: recorder,
    reconcilers: createBackgroundReconcilerFactory({ activity }),
    activity,
    fileChanges: createTestFileChangeService(),
    settings,
    progress,
    clock,
    platform,
    role: 'main',
    graphSession: createTestGraphSessionService({ graph: { generation: 3 } }),
    logger,
  })
  const service = createMobileAudioMemoService({
    audioMemo,
    audioRecorder: recorder,
    nativeAction: createNativeActionService({
      audioRecorder: recorder,
      clock,
      platform,
      logger,
    }),
    activity,
    haptics,
    platform,
    logger,
  })
  const deleted = (): string[] => {
    return recorder
      .calls()
      .filter((call) => call.method === 'deleteStaged')
      .map((call) => call.path)
  }
  const count = (method: string): number => {
    return recorder.calls().filter((call) => call.method === method).length
  }
  return {
    settings,
    noteFile,
    assetStore,
    recorder,
    activity,
    haptics,
    progress,
    logger,
    clock,
    service,
    /**
     * The staged files deleted so far, in order.
     */
    deleted,
    /**
     * How many times the recorder method ran.
     */
    count,
    /**
     * The graph paths captured so far, in order.
     */
    captured: () => assetStore.uploads().map((upload) => upload.path),
    /**
     * How many transcription passes got past the config gate.
     */
    passes: () => listDirMock.mock.calls.filter(([dir]) => dir === AUDIO_MEMOS_DIR).length,
    async open() {
      const session = service.openSession()
      await flush()
      return session
    },
  }
}

/**
 * Settle the promise chains a capture, a scan, or a pass runs on.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('MobileAudioMemoService.openSession', () => {
  it('toggle records with the drawer open, then stops, captures, and deletes the staged file', async () => {
    const kit = await setup()
    const session = await kit.open()
    expect(session.getState().available).toBe(true)
    const passesAtOpen = kit.passes()

    session.toggle()
    await flush()
    expect(kit.recorder.calls()).toContainEqual({
      method: 'start',
      options: { segmentMs: 20 * 60_000, reminderMs: 30 * 60_000 },
    })
    expect(session.getState()).toMatchObject({ phase: 'recording', drawerOpen: true })

    session.toggle()
    await flush()
    expect(session.getState()).toMatchObject({ phase: 'idle', drawerOpen: false })

    // The memo's identity timestamp is the session's start, not wall clock.
    expect(kit.assetStore.uploads()).toEqual([
      { kind: 'audio-memo', path: audioMemoPartPath(MEMO, 1, true), generation: 3 },
    ])
    // The staged file is deleted only after the graph write succeeded.
    expect(kit.deleted()).toEqual([FINAL_STAGED])
    expect(kit.recorder.isStagedClaimed(FINAL_STAGED)).toBe(false)
    expect(kit.passes()).toBe(passesAtOpen + 1)
    // One tap for the start, one for the stop.
    expect(kit.haptics.impacts()).toBe(2)
  })

  it('keeps one state object until something changes, and notifies subscribers', async () => {
    const kit = await setup()
    const session = await kit.open()
    const listener = vi.fn()
    session.subscribe(listener)
    const before = session.getState()
    expect(session.getState()).toBe(before)

    session.toggle()
    await flush()

    expect(listener).toHaveBeenCalled()
    expect(session.getState()).not.toBe(before)
  })

  it('a rotated segment lands in the graph while the session keeps recording', async () => {
    const kit = await setup()
    const session = await kit.open()

    session.toggle()
    await flush()
    kit.recorder.emitSegment(ROTATED)
    await flush()

    expect(kit.captured()).toEqual([audioMemoPartPath(MEMO, 1, false)])
    expect(kit.deleted()).toEqual([ROTATED_STAGED])
    expect(session.getState().phase).toBe('recording')
  })

  it('discarding a session deletes the segments it already wrote to the graph', async () => {
    const kit = await setup()
    const landed = audioMemoPartPath(MEMO, 1, false)
    kit.noteFile.set(landed, 'x')
    const deleteMock = vi.spyOn(kit.assetStore, 'deleteAudioMemo')
    const session = await kit.open()

    session.toggle()
    await flush()
    kit.recorder.emitSegment(ROTATED)
    await flush()
    expect(kit.captured()).toEqual([landed])

    await session.cancelRecording()
    await flush()

    expect(deleteMock).toHaveBeenCalledWith(landed, 3)
    expect(kit.assetStore.assets().size).toBe(0)
  })

  it('a straggler segment from a discarded session is dropped, not resurrected', async () => {
    const kit = await setup()
    const session = await kit.open()

    session.toggle()
    await flush()
    await session.cancelRecording()
    await flush()

    // A staged segment the native discard failed to delete, handed back later.
    kit.recorder.emitSegment({
      ...ROTATED,
      audio: { kind: 'staged', path: STRAGGLER_STAGED },
      part: 2,
    })
    await flush()

    expect(kit.captured()).toEqual([])
    expect(kit.deleted()).toEqual([STRAGGLER_STAGED])
  })

  it('a capture failure keeps the staged file; discard deletes it', async () => {
    const kit = await setup()
    vi.spyOn(kit.assetStore, 'importAudioMemo').mockRejectedValue(new AppError('io', 'disk full'))
    const session = await kit.open()

    session.toggle()
    await flush()
    session.toggle()
    await flush()
    expect(session.getState()).toMatchObject({ phase: 'error', canRetry: true })
    expect(kit.deleted()).toEqual([])
    // The drawer closed on stop — the failure also surfaces as an operation.
    expect(kit.progress.findByLabel('Saving audio memo')).toMatchObject({
      status: 'failed',
      message: 'disk full',
    })

    session.discard()
    await flush()
    expect(kit.deleted()).toEqual([FINAL_STAGED])
  })

  it('retry re-runs the same recording and deletes the staged file on success', async () => {
    const kit = await setup()
    const importMock = vi
      .spyOn(kit.assetStore, 'importAudioMemo')
      .mockRejectedValueOnce(new AppError('io', 'disk full'))
    const session = await kit.open()

    session.toggle()
    await flush()
    session.toggle()
    await flush()
    expect(session.getState().phase).toBe('error')

    session.retry()
    await flush()
    expect(session.getState().phase).toBe('idle')
    expect(importMock).toHaveBeenCalledTimes(2)
    expect(kit.deleted()).toEqual([FINAL_STAGED])
  })

  it('a native stop (interruption, route loss) is ingested exactly like a user stop', async () => {
    const kit = await setup()
    const session = await kit.open()

    session.toggle()
    await flush()
    expect(session.getState().drawerOpen).toBe(true)

    kit.recorder.emitStopped({ segment: RECORDING, reason: 'interruption' })
    expect(session.getState().drawerOpen).toBe(false)
    await flush()

    expect(kit.assetStore.uploads()).toEqual([
      { kind: 'audio-memo', path: audioMemoPartPath(MEMO, 1, true), generation: 3 },
    ])
    expect(session.getState().phase).toBe('idle')
  })

  it('a too-short native stop closes the drawer and captures nothing', async () => {
    const kit = await setup()
    const session = await kit.open()

    session.toggle()
    await flush()
    kit.recorder.emitStopped({ segment: null, reason: 'interruption' })
    await flush()

    expect(session.getState().drawerOpen).toBe(false)
    expect(kit.captured()).toEqual([])
  })

  it('a too-short recording is discarded without saving', async () => {
    const kit = await setup()
    kit.recorder.setStopResult(null)
    const session = await kit.open()

    session.toggle()
    await flush()
    session.stopAndSave()
    await flush()

    expect(session.getState()).toMatchObject({ phase: 'idle', drawerOpen: false })
    expect(kit.captured()).toEqual([])
  })

  it('stopping while nothing records does not reach the recorder', async () => {
    const kit = await setup()
    const session = await kit.open()

    session.stopAndSave()
    await flush()

    expect(kit.count('stop')).toBe(0)
    expect(session.getState().phase).toBe('idle')
  })

  it('level events feed the waveform and reset when the session ends', async () => {
    const kit = await setup()
    const session = await kit.open()
    session.toggle()
    await flush()

    kit.recorder.emitLevel({ level: 0.5, elapsedMs: 1200 })
    expect(session.getState()).toMatchObject({ level: 0.5, elapsedMs: 1200 })

    await session.cancelRecording()
    await flush()
    expect(session.getState()).toMatchObject({ phase: 'idle', level: 0, elapsedMs: 0 })
  })

  it('dismissing the drawer mid-recording stops and saves, never drops', async () => {
    const kit = await setup()
    const session = await kit.open()

    session.toggle()
    await flush()
    session.setDrawerOpen(false)
    await flush()

    expect(kit.captured()).toEqual([audioMemoPartPath(MEMO, 1, true)])
    expect(kit.count('cancel')).toBe(0)
  })

  it('dismissing the drawer during the permission prompt abandons the request', async () => {
    const kit = await setup()
    const session = await kit.open()
    kit.recorder.holdNextStart()

    session.toggle()
    await flush()
    expect(session.getState().phase).toBe('requesting')

    session.setDrawerOpen(false)
    await flush()

    expect(kit.count('cancel')).toBe(1)
    expect(session.getState()).toMatchObject({ phase: 'idle', drawerOpen: false })
  })

  it('a second toggle during the permission prompt aborts the request and closes the drawer', async () => {
    const kit = await setup()
    const session = await kit.open()
    kit.recorder.holdNextStart()

    session.toggle()
    await flush()
    session.toggle()
    await flush()

    expect(kit.count('cancel')).toBe(1)
    expect(session.getState()).toMatchObject({ phase: 'idle', drawerOpen: false })
  })

  it('the drawer Cancel discards the live recording without saving', async () => {
    const kit = await setup()
    const session = await kit.open()

    session.toggle()
    await flush()
    await session.cancelRecording()
    await flush()

    expect(session.getState().drawerOpen).toBe(false)
    expect(kit.count('cancel')).toBe(1)
    expect(kit.captured()).toEqual([])
  })

  it('a denied microphone shows the iOS Settings guidance in the drawer', async () => {
    const kit = await setup()
    const session = await kit.open()
    kit.recorder.failNextStart('microphone access denied')

    session.toggle()
    await flush()

    expect(session.getState()).toMatchObject({
      phase: 'error',
      drawerOpen: true,
      error: 'Microphone access was denied. Allow it for Reflect in the Settings app.',
      canRetry: false,
    })
  })

  it('a parked error reopens the drawer from the audio action instead of blocking silently', async () => {
    const kit = await setup()
    vi.spyOn(kit.assetStore, 'importAudioMemo').mockRejectedValue(new AppError('io', 'disk full'))
    const session = await kit.open()

    session.toggle()
    await flush()
    session.toggle()
    await flush()
    expect(session.getState()).toMatchObject({ phase: 'error', drawerOpen: false })

    session.toggle()
    await flush()
    expect(session.getState()).toMatchObject({ phase: 'error', drawerOpen: true })
  })

  it('the orphan scan ingests unclaimed staged segments under their session, then deletes them', async () => {
    const kit = await setup()
    kit.recorder.setStaged([
      stagedFile(FINAL_STAGED, SESSION_STARTED_MS, true),
      stagedFile(CLAIMED_STAGED, SESSION_STARTED_MS + 100_000, false),
    ])
    kit.recorder.claimStaged(CLAIMED_STAGED)

    await kit.open()

    expect(kit.assetStore.uploads()).toEqual([
      { kind: 'audio-memo', path: audioMemoPartPath(MEMO, 1, true), generation: 3 },
    ])
    expect(kit.deleted()).toEqual([FINAL_STAGED])
  })

  it('foregrounding re-runs the orphan scan', async () => {
    const kit = await setup()
    await kit.open()
    expect(kit.count('listStaged')).toBe(1)

    kit.activity.emitVisible()
    await flush()

    expect(kit.count('listStaged')).toBe(2)
  })

  it('a failed orphan scan is logged', async () => {
    const kit = await setup()
    const cause = new Error('staging unavailable')
    vi.spyOn(kit.recorder, 'listStaged').mockRejectedValue(cause)

    await kit.open()

    expect(kit.logger.getErrors()).toEqual([{ message: 'audio memo orphan scan failed:', cause }])
  })

  it('a recording that outlived its JS is stopped and saved when the session opens', async () => {
    const kit = await setup()
    await kit.recorder.start({ segmentMs: 1, reminderMs: 1 })
    const orphanStartedMs = 1_700_000_050_000
    kit.recorder.setStopResult({
      ...RECORDING,
      audio: { kind: 'staged', path: ORPHAN_STAGED },
      sessionStartedMs: orphanStartedMs,
    })

    await kit.open()

    expect(kit.count('stop')).toBe(1)
    const orphan = audioMemoIdentity(new Date(orphanStartedMs), 'audio/mp4')
    expect(kit.captured()).toEqual([audioMemoPartPath(orphan, 1, true)])
    expect(kit.deleted()).toEqual([ORPHAN_STAGED])
  })

  it('no live native recording when the session opens means no stop call', async () => {
    const kit = await setup()

    await kit.open()

    expect(kit.count('status')).toBe(1)
    expect(kit.count('stop')).toBe(0)
  })

  it('the handshake claims queued actions: recordAudio records, then confirms', async () => {
    const kit = await setup()
    const session = await kit.open()
    expect(kit.count('actionsReady')).toBe(1)

    kit.recorder.emitNativeAction({ action: 'recordAudio' })
    await flush()
    expect(kit.count('start')).toBe(1)
    expect(session.getState().drawerOpen).toBe(true)

    // Confirmation waits until the recording UI has survived presentation —
    // a crash in that window must leave the action queued for next launch.
    expect(kit.count('actionPerformed')).toBe(0)
    await kit.clock.advance(2000)
    expect(kit.count('actionPerformed')).toBe(1)
  })

  it('without an OpenAI or Gemini model, toggle opens the drawer for key setup, never the mic', async () => {
    const kit = await setup({ providers: ANTHROPIC_ONLY })
    const session = await kit.open()

    // The audio action stays available so the feature is discoverable; only
    // the recording itself waits for a key.
    expect(session.getState()).toMatchObject({ available: true, hasTranscriptionConfig: false })

    session.toggle()
    await flush()
    expect(session.getState()).toMatchObject({ drawerOpen: true, phase: 'idle' })
    expect(kit.count('start')).toBe(0)
  })

  it('is unavailable outside the native shell, and nothing reaches the recorder', async () => {
    const kit = await setup({ isNativeShell: false })
    const session = await kit.open()
    expect(session.getState().available).toBe(false)

    session.toggle()
    await flush()

    expect(kit.recorder.calls()).toEqual([])
    expect(session.getState().drawerOpen).toBe(false)
  })

  it('dispose detaches from the recorder and leaves a live recording running', async () => {
    const kit = await setup()
    const session = await kit.open()
    session.toggle()
    await flush()

    session.dispose()
    kit.recorder.emitStopped({ segment: RECORDING, reason: 'interruption' })
    kit.activity.emitVisible()
    await flush()

    expect(kit.count('cancel')).toBe(0)
    expect(kit.captured()).toEqual([])
    expect(kit.count('listStaged')).toBe(1)
  })
})
