import { act } from '@/test-utils/act.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  audioMemoIdentity,
  audioMemoPartPath,
  type AiProviderConfig,
  type AudioRecorderFinalSegment,
  type GraphInfo,
  AppError,
} from '@reflect/core'
import {
  createTestCoreServices,
  createTestAssetStoreService,
  createTestAudioRecorderService,
  createTestPlatformService,
} from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { MobileAudioMemoProvider, useMobileAudioMemo } from './audio-memo-provider.tsx'

const GRAPH: GraphInfo = { root: '/notes', name: 'Notes', generation: 3 }

const OPENAI: AiProviderConfig = {
  id: 'cfg-openai',
  provider: 'openai',
  model: 'gpt-5.1',
  keyHint: 'wxyz1',
}
const ANTHROPIC: AiProviderConfig = {
  id: 'claude',
  provider: 'anthropic',
  model: 'claude-fable-5',
  keyHint: 'wxyz1',
}

const SESSION_STARTED_MS = 1_700_000_000_000
const STAGED = '/staging/recording-1700000000000.part-001-end.m4a'
const FINAL_PATH = audioMemoPartPath(
  audioMemoIdentity(new Date(SESSION_STARTED_MS), 'audio/mp4'),
  1,
  true,
)

const RECORDING: AudioRecorderFinalSegment = {
  audio: { kind: 'staged', path: STAGED },
  mimeType: 'audio/mp4',
  sessionStartedMs: SESSION_STARTED_MS,
  part: 1,
  end: true,
  durationMs: 4000,
}

async function setup(provider: AiProviderConfig = OPENAI) {
  const audioRecorder = createTestAudioRecorderService({ sessionStartedMs: SESSION_STARTED_MS })
  audioRecorder.setStopResult(RECORDING)
  const assetStore = createTestAssetStoreService({ sources: { [STAGED]: 'audio' } })
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    audioRecorder,
    assetStore,
    platform: createTestPlatformService({ appPlatform: 'ios' }),
  })

  const hook = await renderHookInApp(() => useMobileAudioMemo(), {
    app,
    graph: GRAPH,
    settings: { aiProviders: [provider], defaultAiProviderId: provider.id },
    wrapper: (children) => (
      <MobileAudioMemoProvider graph={GRAPH}>{children}</MobileAudioMemoProvider>
    ),
  })
  const count = (method: string): number =>
    audioRecorder.calls().filter((call) => call.method === method).length
  return { ...hook, audioRecorder, assetStore, count }
}

describe('MobileAudioMemoProvider', () => {
  it('opens the session before the first paint and shows its state', async () => {
    const { result } = await setup()

    expect(result.current).toMatchObject({
      phase: 'idle',
      available: true,
      hasTranscriptionConfig: true,
      drawerOpen: false,
      pendingCount: 0,
      error: null,
      canRetry: false,
    })
  })

  it('toggle records with the drawer open, then stops, captures, and deletes the staged file', async () => {
    const { result, audioRecorder, assetStore } = await setup()

    await act(() => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('recording')
    expect(result.current.drawerOpen).toBe(true)

    await act(() => {
      result.current.toggle()
    })
    await vi.waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(result.current.drawerOpen).toBe(false)

    expect(assetStore.uploads()).toEqual([{ kind: 'audio-memo', path: FINAL_PATH, generation: 3 }])
    // The staged file is deleted only after the graph write succeeded.
    expect(audioRecorder.calls()).toContainEqual({ method: 'deleteStaged', path: STAGED })
  })

  it('level events reach the waveform', async () => {
    const { result, audioRecorder } = await setup()
    await act(() => {
      result.current.toggle()
    })

    await act(() => {
      audioRecorder.emitLevel({ level: 0.5, elapsedMs: 1200 })
    })

    expect(result.current.level).toBe(0.5)
    expect(result.current.elapsedMs).toBe(1200)
  })

  it('dismissing the drawer mid-recording stops and saves, never drops', async () => {
    const { result, assetStore, count } = await setup()

    await act(() => {
      result.current.toggle()
    })
    await act(() => {
      result.current.onDrawerOpenChange(false)
    })

    await vi.waitFor(() => expect(assetStore.uploads()).toHaveLength(1))
    expect(result.current.drawerOpen).toBe(false)
    expect(count('cancel')).toBe(0)
  })

  it('the drawer stop control commits the memo', async () => {
    const { result, assetStore } = await setup()

    await act(() => {
      result.current.toggle()
    })
    await act(() => {
      result.current.stopAndSave()
    })

    await vi.waitFor(() => expect(assetStore.uploads()).toHaveLength(1))
  })

  it('the drawer Cancel discards the live recording without saving', async () => {
    const { result, assetStore, count } = await setup()

    await act(() => {
      result.current.toggle()
    })
    await act(async () => {
      await result.current.cancelRecording()
    })

    expect(result.current.drawerOpen).toBe(false)
    expect(count('cancel')).toBe(1)
    expect(assetStore.uploads()).toEqual([])
  })

  it('a capture failure shows in the drawer with retry and discard', async () => {
    const { result, assetStore, audioRecorder } = await setup()
    vi.spyOn(assetStore, 'importAudioMemo').mockRejectedValueOnce(new AppError('io', 'disk full'))

    await act(() => {
      result.current.toggle()
    })
    await act(() => {
      result.current.toggle()
    })
    await vi.waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.error).toBe('disk full')
    expect(result.current.canRetry).toBe(true)

    await act(() => {
      result.current.retry()
    })
    await vi.waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(audioRecorder.calls()).toContainEqual({ method: 'deleteStaged', path: STAGED })
  })

  it('without an OpenAI or Gemini model, toggle opens the drawer for key setup, never the mic', async () => {
    const { result, count } = await setup(ANTHROPIC)

    // The audio action stays available so the feature is discoverable; only
    // the recording itself waits for a key.
    expect(result.current.available).toBe(true)
    expect(result.current.hasTranscriptionConfig).toBe(false)

    await act(() => {
      result.current.toggle()
    })
    expect(result.current.drawerOpen).toBe(true)
    expect(result.current.phase).toBe('idle')
    expect(count('start')).toBe(0)
  })

  it('unmounting closes the session and leaves a live recording running', async () => {
    const { result, app, audioRecorder, assetStore, unmount } = await setup()
    await act(() => {
      result.current.toggle()
    })

    await unmount()
    audioRecorder.emitStopped({ segment: RECORDING, reason: 'interruption' })

    expect(app.fileChanges.listenerCount().changes).toBe(0)
    expect(assetStore.uploads()).toEqual([])
  })
})
