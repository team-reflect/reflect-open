import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState, type ReactElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiProvidersState,
  AudioMemoIdentity,
  CaptureAudioMemoInput,
  CaptureAudioMemoOutcome,
  GraphInfo,
  Settings,
} from '@reflect/core'
import type { NativeRecorderResult } from '@/mobile/use-native-audio-recorder'

const captureAudioMemo = vi.hoisted(() =>
  vi.fn<(input: CaptureAudioMemoInput) => Promise<CaptureAudioMemoOutcome>>(),
)
const failOperation = vi.hoisted(() => vi.fn<(message: string) => void>())
const invoke = vi.hoisted(() => vi.fn<(command: string, args?: unknown) => Promise<unknown>>())

/** Captured plugin-event handlers, keyed by event name, dispatchable per test. */
const pluginEvents = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  emit(event: string, payload: unknown): void {
    pluginEvents.handlers.get(event)?.(payload)
  },
}))

/** Fake reconciler lifecycle — the pipeline is only a shim over it. */
const reconcilerControls = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const fake = {
    start: vi.fn(),
    schedule: vi.fn(),
    dispose: vi.fn(),
    getTranscribing: vi.fn((): boolean => false),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
  }
  return { fake, listeners }
})
const createTranscriptionReconciler = vi.hoisted(() =>
  vi.fn(
    (_options: {
      generation: number
      getProviders: () => AiProvidersState
      getTranscriptionFormat: () => boolean
    }) => reconcilerControls.fake,
  ),
)

const recorderControls = vi.hoisted(() => ({
  startSpy: vi.fn(),
  stopSpy: vi.fn(),
  cancelSpy: vi.fn(),
  stopResult: null as NativeRecorderResult | null,
  /** Make start() reject like a denied native permission. */
  failStart: null as string | null,
  options: null as {
    maxDurationMs: number
    onNativeStop: (result: NativeRecorderResult | null) => void
  } | null,
}))

const stagedControls = vi.hoisted(() => ({
  claimed: new Set<string>(),
  readStaged: vi.fn<(path: string) => Promise<Blob>>(),
  deleteStaged: vi.fn<(path: string) => Promise<void>>(),
  recordingStatus: vi.fn<() => Promise<{ recording: boolean; elapsedMs: number }>>(),
  stopActive: vi.fn<() => Promise<NativeRecorderResult | null>>(),
}))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  captureAudioMemo,
  hasBridge: () => true,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  addPluginListener: vi.fn(
    async (_plugin: string, event: string, handler: (payload: unknown) => void) => {
      pluginEvents.handlers.set(event, handler)
      return { unregister: vi.fn() }
    },
  ),
}))

vi.mock('@/lib/transcription-reconciler', () => ({
  createTranscriptionReconciler,
}))

vi.mock('@/lib/operations', () => ({
  startOperation: () => ({ progress: vi.fn(), done: vi.fn(), fail: failOperation }),
}))

vi.mock('@/mobile/haptics', () => ({
  hapticImpactLight: vi.fn(),
}))

vi.mock('@/mobile/use-native-audio-recorder', () => ({
  NATIVE_RECORDING_MIME: 'audio/mp4',
  isMicDeniedError: (cause: unknown) => typeof cause === 'string' && cause.includes('denied'),
  readStagedRecording: stagedControls.readStaged,
  deleteStagedRecording: stagedControls.deleteStaged,
  nativeRecordingStatus: stagedControls.recordingStatus,
  stopActiveRecording: stagedControls.stopActive,
  claimStagedPath: (path: string) => stagedControls.claimed.add(path),
  releaseStagedPath: (path: string) => stagedControls.claimed.delete(path),
  isStagedPathClaimed: (path: string) => stagedControls.claimed.has(path),
  useNativeAudioRecorder: (options: {
    maxDurationMs: number
    onNativeStop: (result: NativeRecorderResult | null) => void
  }) => {
    recorderControls.options = options
    const [status, setStatus] = useState<'idle' | 'requesting' | 'recording'>('idle')
    return {
      status,
      elapsedMs: 0,
      level: 0,
      start: async () => {
        recorderControls.startSpy()
        if (recorderControls.failStart !== null) {
          throw recorderControls.failStart
        }
        setStatus('recording')
      },
      stop: async () => {
        recorderControls.stopSpy()
        setStatus('idle')
        return recorderControls.stopResult
      },
      cancel: async () => {
        recorderControls.cancelSpy()
        setStatus('idle')
      },
    }
  },
}))

const SETTINGS = vi.hoisted(() => ({
  current: {
    aiProviders: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.1', keyHint: 'wxyz1' }],
    defaultAiProviderId: 'cfg-openai',
    transcriptionFormat: true,
  },
}))

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: SETTINGS.current as unknown as Settings }),
}))

const { MobileAudioMemoProvider, useMobileAudioMemo } = await import('./audio-memo-provider')

const GRAPH: GraphInfo = { root: '/notes', name: 'Notes', generation: 3 }

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <MobileAudioMemoProvider graph={GRAPH}>{children}</MobileAudioMemoProvider>
}

const RECORDING: NativeRecorderResult = {
  blob: new Blob(['audio'], { type: 'audio/mp4' }),
  mimeType: 'audio/mp4',
  durationMs: 4000,
  stagedPath: '/staging/recording-1.m4a',
  recordedAt: new Date(1_700_000_000_000),
}

const MEMO: AudioMemoIdentity = {
  base: 'audio-memo-2026-06-11-153022-845',
  date: '2026-06-11',
  title: 'Audio memo 2026-06-11 15:30:22',
  alias: 'Audio memo 15:30',
  audioPath: 'audio-memos/audio-memo-2026-06-11-153022-845.m4a',
  notePath: 'notes/audio-memo-2026-06-11-153022-845.md',
  mimeType: 'audio/mp4',
}

beforeEach(() => {
  vi.clearAllMocks()
  recorderControls.stopResult = RECORDING
  recorderControls.failStart = null
  recorderControls.options = null
  stagedControls.claimed.clear()
  stagedControls.readStaged.mockResolvedValue(new Blob(['staged'], { type: 'audio/mp4' }))
  stagedControls.deleteStaged.mockResolvedValue(undefined)
  stagedControls.recordingStatus.mockResolvedValue({ recording: false, elapsedMs: 0 })
  stagedControls.stopActive.mockResolvedValue(null)
  SETTINGS.current = {
    aiProviders: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.1', keyHint: 'wxyz1' }],
    defaultAiProviderId: 'cfg-openai',
    transcriptionFormat: true,
  }
  captureAudioMemo.mockResolvedValue({ ok: true, memo: MEMO })
  invoke.mockResolvedValue({ files: [] })
  pluginEvents.handlers.clear()
  reconcilerControls.fake.getTranscribing.mockReturnValue(false)
  reconcilerControls.listeners.clear()
})

afterEach(cleanup)

describe('MobileAudioMemoProvider', () => {
  it('toggle records with the drawer open, then stops, captures, and deletes the staged file', async () => {
    const { result } = renderHook(() => useMobileAudioMemo(), { wrapper })
    expect(result.current.available).toBe(true)
    expect(recorderControls.options?.maxDurationMs).toBe(10 * 60_000)

    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('recording')
    expect(result.current.drawerOpen).toBe(true)

    await act(async () => {
      result.current.toggle()
    })
    await waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(result.current.drawerOpen).toBe(false)

    expect(captureAudioMemo).toHaveBeenCalledWith({
      audio: RECORDING.blob,
      mimeType: 'audio/mp4',
      recordedAt: expect.any(Date),
      generation: 3,
      onCaptured: expect.any(Function),
      onDiscarded: expect.any(Function),
    })
    // The staged file is deleted only after the graph write succeeded.
    expect(stagedControls.deleteStaged).toHaveBeenCalledWith(RECORDING.stagedPath)
    expect(reconcilerControls.fake.schedule).toHaveBeenCalled()
  })

  it('a capture failure keeps the staged file; discard deletes it', async () => {
    captureAudioMemo.mockResolvedValue({ ok: false, message: 'disk full' })
    const { result } = renderHook(() => useMobileAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.canRetry).toBe(true)
    expect(stagedControls.deleteStaged).not.toHaveBeenCalled()
    // The drawer closed on stop — the failure also surfaces as an operation.
    expect(failOperation).toHaveBeenCalledWith('disk full')

    await act(async () => {
      result.current.discard()
    })
    await waitFor(() =>
      expect(stagedControls.deleteStaged).toHaveBeenCalledWith(RECORDING.stagedPath),
    )
  })

  it('retry re-runs the same recording and deletes the staged file on success', async () => {
    captureAudioMemo
      .mockResolvedValueOnce({ ok: false, message: 'disk full' })
      .mockResolvedValueOnce({ ok: true, memo: MEMO })
    const { result } = renderHook(() => useMobileAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await waitFor(() => expect(result.current.phase).toBe('error'))

    await act(async () => {
      result.current.retry()
    })
    await waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(captureAudioMemo).toHaveBeenCalledTimes(2)
    expect(stagedControls.deleteStaged).toHaveBeenCalledWith(RECORDING.stagedPath)
  })

  it('a native stop (interruption, cap) is ingested exactly like a user stop', async () => {
    const { result } = renderHook(() => useMobileAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.drawerOpen).toBe(true)

    await act(async () => {
      recorderControls.options?.onNativeStop(RECORDING)
    })

    expect(result.current.drawerOpen).toBe(false)
    await waitFor(() =>
      expect(captureAudioMemo).toHaveBeenCalledWith(
        expect.objectContaining({ audio: RECORDING.blob, generation: 3 }),
      ),
    )
  })

  it('a too-short native stop closes the drawer and captures nothing', async () => {
    const { result } = renderHook(() => useMobileAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      recorderControls.options?.onNativeStop(null)
    })

    expect(result.current.drawerOpen).toBe(false)
    expect(captureAudioMemo).not.toHaveBeenCalled()
  })

  it('dismissing the drawer mid-recording stops and saves, never drops', async () => {
    const { result } = renderHook(() => useMobileAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.onDrawerOpenChange(false)
    })

    await waitFor(() => expect(captureAudioMemo).toHaveBeenCalled())
    expect(recorderControls.cancelSpy).not.toHaveBeenCalled()
  })

  it('the drawer Cancel discards the live recording without saving', async () => {
    const { result } = renderHook(() => useMobileAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.cancelRecording()
    })

    expect(result.current.drawerOpen).toBe(false)
    expect(recorderControls.cancelSpy).toHaveBeenCalled()
    expect(captureAudioMemo).not.toHaveBeenCalled()
  })

  it('a denied microphone shows the iOS Settings guidance in the drawer', async () => {
    recorderControls.failStart = 'microphone access denied'
    const { result } = renderHook(() => useMobileAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })

    await waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.drawerOpen).toBe(true)
    expect(result.current.error).toMatch(/Settings app/)
    expect(result.current.canRetry).toBe(false)
  })

  it('a parked error reopens the drawer from the FAB instead of blocking silently', async () => {
    captureAudioMemo.mockResolvedValue({ ok: false, message: 'disk full' })
    const { result } = renderHook(() => useMobileAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.drawerOpen).toBe(false)

    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.drawerOpen).toBe(true)
    expect(result.current.phase).toBe('error')
  })

  it('the orphan scan ingests unclaimed staged files by their stop time, then deletes them', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:recording|list_staged') {
        return {
          files: [
            { path: '/staging/recording-old.m4a', modifiedMs: 1_700_000_000_000 },
            { path: '/staging/recording-claimed.m4a', modifiedMs: 1_700_000_100_000 },
          ],
        }
      }
      throw new Error(`unexpected invoke: ${command}`)
    })
    stagedControls.claimed.add('/staging/recording-claimed.m4a')

    renderHook(() => useMobileAudioMemo(), { wrapper })

    await waitFor(() => expect(captureAudioMemo).toHaveBeenCalledTimes(1))
    expect(captureAudioMemo).toHaveBeenCalledWith(
      expect.objectContaining({
        recordedAt: new Date(1_700_000_000_000),
        generation: 3,
      }),
    )
    await waitFor(() =>
      expect(stagedControls.deleteStaged).toHaveBeenCalledWith('/staging/recording-old.m4a'),
    )
    expect(stagedControls.readStaged).not.toHaveBeenCalledWith('/staging/recording-claimed.m4a')
  })

  it('foregrounding re-runs the orphan scan', async () => {
    renderHook(() => useMobileAudioMemo(), { wrapper })
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('plugin:recording|list_staged'),
    )
    invoke.mockClear()

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('plugin:recording|list_staged'),
    )
  })

  it('a recording that outlived its JS is stopped and saved on mount', async () => {
    stagedControls.recordingStatus.mockResolvedValue({ recording: true, elapsedMs: 30_000 })
    const orphaned: NativeRecorderResult = {
      blob: new Blob(['orphan'], { type: 'audio/mp4' }),
      mimeType: 'audio/mp4',
      durationMs: 30_000,
      stagedPath: '/staging/recording-orphan.m4a',
      recordedAt: new Date(1_700_000_050_000),
    }
    stagedControls.stopActive.mockResolvedValue(orphaned)

    renderHook(() => useMobileAudioMemo(), { wrapper })

    await waitFor(() => expect(stagedControls.stopActive).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(captureAudioMemo).toHaveBeenCalledWith(
        expect.objectContaining({ audio: orphaned.blob, generation: 3 }),
      ),
    )
    await waitFor(() =>
      expect(stagedControls.deleteStaged).toHaveBeenCalledWith(orphaned.stagedPath),
    )
  })

  it('no live native recording on mount means no stop call', async () => {
    renderHook(() => useMobileAudioMemo(), { wrapper })

    await waitFor(() => expect(stagedControls.recordingStatus).toHaveBeenCalled())
    expect(stagedControls.stopActive).not.toHaveBeenCalled()
  })

  it('the handshake claims queued actions: recordAudio records, then confirms', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useMobileAudioMemo(), { wrapper })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(invoke).toHaveBeenCalledWith('plugin:recording|actions_ready')

      await act(async () => {
        pluginEvents.emit('nativeAction', { action: 'recordAudio' })
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(recorderControls.startSpy).toHaveBeenCalledTimes(1)
      expect(result.current.drawerOpen).toBe(true)

      // Confirmation waits until the recording UI has survived presentation —
      // a crash in that window must leave the action queued for next launch.
      expect(invoke).not.toHaveBeenCalledWith('plugin:recording|action_performed')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(invoke).toHaveBeenCalledWith('plugin:recording|action_performed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('unknown native actions are ignored', async () => {
    vi.useFakeTimers()
    try {
      renderHook(() => useMobileAudioMemo(), { wrapper })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      await act(async () => {
        pluginEvents.emit('nativeAction', { action: 'somethingElse' })
        await vi.advanceTimersByTimeAsync(2000)
      })

      expect(recorderControls.startSpy).not.toHaveBeenCalled()
      expect(invoke).not.toHaveBeenCalledWith('plugin:recording|action_performed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('without an OpenAI or Gemini model, toggle opens the drawer for key setup, never the mic', async () => {
    SETTINGS.current = {
      aiProviders: [
        { id: 'claude', provider: 'anthropic', model: 'claude-fable-5', keyHint: 'wxyz1' },
      ],
      defaultAiProviderId: 'claude',
      transcriptionFormat: true,
    }
    const { result } = renderHook(() => useMobileAudioMemo(), { wrapper })

    // The FAB stays visible (available) so the feature is discoverable; only
    // the recording itself waits for a key.
    expect(result.current.available).toBe(true)
    expect(result.current.hasTranscriptionConfig).toBe(false)

    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.drawerOpen).toBe(true)
    expect(result.current.phase).toBe('idle')
    expect(recorderControls.startSpy).not.toHaveBeenCalled()
  })
})
