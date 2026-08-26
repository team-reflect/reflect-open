import { act, useState, type ReactElement, type ReactNode } from 'react'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { audioMemoIdentity, audioMemoPartPath, setBridge } from '@reflect/core'
import type {
  AiProvidersState,
  AudioMemoIdentity,
  CaptureAudioMemoInput,
  CaptureAudioMemoOutcome,
  GraphInfo,
  Settings,
} from '@reflect/core'
import type { NativeRecordingPart } from '@/mobile/use-native-audio-recorder'

const captureAudioMemo = vi.hoisted(() =>
  vi.fn<(input: CaptureAudioMemoInput) => Promise<CaptureAudioMemoOutcome>>(),
)
const failOperation = vi.hoisted(() => vi.fn<(message: string) => void>())
const invoke = vi.fn<(command: string, args?: unknown) => Promise<unknown>>()

/** Captured plugin-event handlers, keyed by event name, dispatchable per test. */
const pluginEvents = {
  handlers: new Map<string, (payload: unknown) => void>(),
  emit(event: string, payload: unknown): void {
    pluginEvents.handlers.get(event)?.(payload)
  },
}

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
  stopResult: null as NativeRecordingPart | null,
  /** Make start() reject like a denied native permission. */
  failStart: null as string | null,
  options: null as {
    segmentMs: number
    onSegment: (part: NativeRecordingPart) => void
    onNativeStop: (part: NativeRecordingPart | null) => void
  } | null,
}))

const stagedControls = vi.hoisted(() => ({
  claimed: new Set<string>(),
  deleteStaged: vi.fn<(path: string) => Promise<void>>(),
  recordingStatus: vi.fn<() => Promise<{ recording: boolean; elapsedMs: number }>>(),
  stopActive: vi.fn<() => Promise<NativeRecordingPart | null>>(),
}))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  captureAudioMemo,
}))

vi.mock('@/lib/platform', () => ({ isMacosDesktop: false, isNativeShell: () => true }))

vi.mock('@/lib/transcription-reconciler', () => ({
  createTranscriptionReconciler,
}))

vi.mock('@/lib/operations', () => ({
  startOperation: () => ({
    progress: vi.fn(),
    done: vi.fn(),
    fail: failOperation,
  }),
}))

vi.mock('@/mobile/haptics', () => ({
  hapticImpactLight: vi.fn(),
}))

vi.mock('@/mobile/use-native-audio-recorder', () => ({
  NATIVE_RECORDING_MIME: 'audio/mp4',
  isMicDeniedError: (cause: unknown) => typeof cause === 'string' && cause.includes('denied'),
  deleteStagedRecording: stagedControls.deleteStaged,
  nativeRecordingStatus: stagedControls.recordingStatus,
  stopActiveRecording: stagedControls.stopActive,
  claimStagedPath: (path: string) => stagedControls.claimed.add(path),
  releaseStagedPath: (path: string) => stagedControls.claimed.delete(path),
  isStagedPathClaimed: (path: string) => stagedControls.claimed.has(path),
  useNativeAudioRecorder: (options: {
    segmentMs: number
    onSegment: (part: NativeRecordingPart) => void
    onNativeStop: (part: NativeRecordingPart | null) => void
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
        return SESSION_STARTED_AT
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
    aiProviders: [
      {
        id: 'cfg-openai',
        provider: 'openai',
        model: 'gpt-5.1',
        keyHint: 'wxyz1',
      },
    ],
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

/** Every session in these tests starts here; segments share the timestamp. */
const SESSION_STARTED_AT = new Date(1_700_000_000_000)

const RECORDING: NativeRecordingPart = {
  stagedPath: '/staging/recording-1700000000000.part-001-end.m4a',
  recordedAt: SESSION_STARTED_AT,
  part: 1,
  end: true,
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
  stagedControls.deleteStaged.mockResolvedValue(undefined)
  stagedControls.recordingStatus.mockResolvedValue({
    recording: false,
    elapsedMs: 0,
  })
  stagedControls.stopActive.mockResolvedValue(null)
  SETTINGS.current = {
    aiProviders: [
      {
        id: 'cfg-openai',
        provider: 'openai',
        model: 'gpt-5.1',
        keyHint: 'wxyz1',
      },
    ],
    defaultAiProviderId: 'cfg-openai',
    transcriptionFormat: true,
  }
  captureAudioMemo.mockResolvedValue({ ok: true, memo: MEMO })
  invoke.mockResolvedValue({ files: [] })
  pluginEvents.handlers.clear()
  // A fresh bridge object per test: the shared plugin-event registration in
  // core is keyed by bridge identity, so reusing one object would leak
  // listeners across tests.
  setBridge({
    invoke,
    listen: async () => () => {},
    listenPlugin: async (_plugin, event, handler) => {
      pluginEvents.handlers.set(event, handler)
    },
  })
  reconcilerControls.fake.getTranscribing.mockReturnValue(false)
  reconcilerControls.listeners.clear()
})

afterEach(async () => {
  await cleanup()
  setBridge(null)
})

describe('MobileAudioMemoProvider', () => {
  it('toggle records with the drawer open, then stops, captures, and deletes the staged file', async () => {
    const { result } = await renderHook(() => useMobileAudioMemo(), {
      wrapper,
    })
    expect(result.current.available).toBe(true)
    expect(recorderControls.options?.segmentMs).toBe(20 * 60_000)

    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('recording')
    expect(result.current.drawerOpen).toBe(true)

    await act(async () => {
      result.current.toggle()
    })
    await vi.waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(result.current.drawerOpen).toBe(false)

    expect(captureAudioMemo).toHaveBeenCalledWith({
      audio: { sourcePath: RECORDING.stagedPath },
      mimeType: 'audio/mp4',
      recordedAt: SESSION_STARTED_AT,
      segment: { part: 1, end: true },
      generation: 3,
      onCaptured: expect.any(Function),
      onDiscarded: expect.any(Function),
    })
    // The staged file is deleted only after the graph write succeeded.
    expect(stagedControls.deleteStaged).toHaveBeenCalledWith(RECORDING.stagedPath)
    expect(reconcilerControls.fake.schedule).toHaveBeenCalled()
  })

  it('a rotated segment lands in the graph while the session keeps recording', async () => {
    const { result } = await renderHook(() => useMobileAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      recorderControls.options?.onSegment({
        stagedPath: '/staging/recording-1700000000000.part-001.m4a',
        recordedAt: SESSION_STARTED_AT,
        part: 1,
        end: false,
      })
    })

    await vi.waitFor(() =>
      expect(captureAudioMemo).toHaveBeenCalledWith(
        expect.objectContaining({
          audio: { sourcePath: '/staging/recording-1700000000000.part-001.m4a' },
          segment: { part: 1, end: false },
        }),
      ),
    )
    expect(result.current.phase).toBe('recording')
  })

  it('discarding a session deletes the segments it already wrote to the graph', async () => {
    const memo = audioMemoIdentity(SESSION_STARTED_AT, 'audio/mp4')
    const landed = audioMemoPartPath(memo, 1, false)
    invoke.mockImplementation(async (command: string) => {
      if (command === 'dir_list') {
        return [{ path: landed, size: 1, modifiedMs: 0 }]
      }
      return { files: [] }
    })
    const { result } = await renderHook(() => useMobileAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      recorderControls.options?.onSegment({
        stagedPath: '/staging/recording-1700000000000.part-001.m4a',
        recordedAt: SESSION_STARTED_AT,
        part: 1,
        end: false,
      })
    })
    await vi.waitFor(() => expect(captureAudioMemo).toHaveBeenCalled())

    await act(async () => {
      result.current.cancelRecording()
    })

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('audio_memo_delete', { path: landed, generation: 3 }),
    )
  })

  it('a capture failure keeps the staged file; discard deletes it', async () => {
    captureAudioMemo.mockResolvedValue({ ok: false, message: 'disk full' })
    const { result } = await renderHook(() => useMobileAudioMemo(), {
      wrapper,
    })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await vi.waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.canRetry).toBe(true)
    expect(stagedControls.deleteStaged).not.toHaveBeenCalled()
    // The drawer closed on stop — the failure also surfaces as an operation.
    expect(failOperation).toHaveBeenCalledWith('disk full')

    await act(async () => {
      result.current.discard()
    })
    await vi.waitFor(() =>
      expect(stagedControls.deleteStaged).toHaveBeenCalledWith(RECORDING.stagedPath),
    )
  })

  it('retry re-runs the same recording and deletes the staged file on success', async () => {
    captureAudioMemo
      .mockResolvedValueOnce({ ok: false, message: 'disk full' })
      .mockResolvedValueOnce({ ok: true, memo: MEMO })
    const { result } = await renderHook(() => useMobileAudioMemo(), {
      wrapper,
    })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await vi.waitFor(() => expect(result.current.phase).toBe('error'))

    await act(async () => {
      result.current.retry()
    })
    await vi.waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(captureAudioMemo).toHaveBeenCalledTimes(2)
    expect(stagedControls.deleteStaged).toHaveBeenCalledWith(RECORDING.stagedPath)
  })

  it('a native stop (interruption, route loss) is ingested exactly like a user stop', async () => {
    const { result } = await renderHook(() => useMobileAudioMemo(), {
      wrapper,
    })

    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.drawerOpen).toBe(true)

    await act(async () => {
      recorderControls.options?.onNativeStop(RECORDING)
    })

    expect(result.current.drawerOpen).toBe(false)
    await vi.waitFor(() =>
      expect(captureAudioMemo).toHaveBeenCalledWith(
        expect.objectContaining({ audio: { sourcePath: RECORDING.stagedPath }, generation: 3 }),
      ),
    )
  })

  it('a too-short native stop closes the drawer and captures nothing', async () => {
    const { result } = await renderHook(() => useMobileAudioMemo(), {
      wrapper,
    })

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
    const { result } = await renderHook(() => useMobileAudioMemo(), {
      wrapper,
    })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.onDrawerOpenChange(false)
    })

    await vi.waitFor(() => expect(captureAudioMemo).toHaveBeenCalled())
    expect(recorderControls.cancelSpy).not.toHaveBeenCalled()
  })

  it('the drawer Cancel discards the live recording without saving', async () => {
    const { result } = await renderHook(() => useMobileAudioMemo(), {
      wrapper,
    })

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
    const { result } = await renderHook(() => useMobileAudioMemo(), {
      wrapper,
    })

    await act(async () => {
      result.current.toggle()
    })

    await vi.waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.drawerOpen).toBe(true)
    expect(result.current.error).toMatch(/Settings app/)
    expect(result.current.canRetry).toBe(false)
  })

  it('a parked error reopens the drawer from the FAB instead of blocking silently', async () => {
    captureAudioMemo.mockResolvedValue({ ok: false, message: 'disk full' })
    const { result } = await renderHook(() => useMobileAudioMemo(), {
      wrapper,
    })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await vi.waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.drawerOpen).toBe(false)

    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.drawerOpen).toBe(true)
    expect(result.current.phase).toBe('error')
  })

  it('the orphan scan ingests unclaimed staged segments under their session, then deletes them', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:recording|list_staged') {
        return {
          files: [
            {
              path: '/staging/recording-1700000000000.part-001-end.m4a',
              sessionStartedMs: 1_700_000_000_000,
              part: 1,
              end: true,
              modifiedMs: 1_700_000_000_000,
            },
            {
              path: '/staging/recording-claimed.part-001.m4a',
              sessionStartedMs: 1_700_000_100_000,
              part: 1,
              end: false,
              modifiedMs: 1_700_000_100_000,
            },
          ],
        }
      }
      throw new Error(`unexpected invoke: ${command}`)
    })
    stagedControls.claimed.add('/staging/recording-claimed.part-001.m4a')

    await renderHook(() => useMobileAudioMemo(), { wrapper })

    await vi.waitFor(() => expect(captureAudioMemo).toHaveBeenCalledTimes(1))
    expect(captureAudioMemo).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: { sourcePath: '/staging/recording-1700000000000.part-001-end.m4a' },
        recordedAt: new Date(1_700_000_000_000),
        segment: { part: 1, end: true },
        generation: 3,
      }),
    )
    await vi.waitFor(() =>
      expect(stagedControls.deleteStaged).toHaveBeenCalledWith(
        '/staging/recording-1700000000000.part-001-end.m4a',
      ),
    )
    expect(captureAudioMemo).not.toHaveBeenCalledWith(
      expect.objectContaining({
        audio: { sourcePath: '/staging/recording-claimed.part-001.m4a' },
      }),
    )
  })

  it('foregrounding re-runs the orphan scan', async () => {
    await renderHook(() => useMobileAudioMemo(), { wrapper })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:recording|list_staged', {}))
    invoke.mockClear()

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:recording|list_staged', {}))
  })

  it('a recording that outlived its JS is stopped and saved on mount', async () => {
    stagedControls.recordingStatus.mockResolvedValue({
      recording: true,
      elapsedMs: 30_000,
    })
    const orphaned: NativeRecordingPart = {
      stagedPath: '/staging/recording-1700000050000.part-001-end.m4a',
      recordedAt: new Date(1_700_000_050_000),
      part: 1,
      end: true,
    }
    stagedControls.stopActive.mockResolvedValue(orphaned)

    await renderHook(() => useMobileAudioMemo(), { wrapper })

    await vi.waitFor(() => expect(stagedControls.stopActive).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(captureAudioMemo).toHaveBeenCalledWith(
        expect.objectContaining({ audio: { sourcePath: orphaned.stagedPath }, generation: 3 }),
      ),
    )
    await vi.waitFor(() =>
      expect(stagedControls.deleteStaged).toHaveBeenCalledWith(orphaned.stagedPath),
    )
  })

  it('no live native recording on mount means no stop call', async () => {
    await renderHook(() => useMobileAudioMemo(), { wrapper })

    await vi.waitFor(() => expect(stagedControls.recordingStatus).toHaveBeenCalled())
    expect(stagedControls.stopActive).not.toHaveBeenCalled()
  })

  it('the handshake claims queued actions: recordAudio records, then confirms', async () => {
    vi.useFakeTimers()
    try {
      const { result } = await renderHook(() => useMobileAudioMemo(), {
        wrapper,
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(invoke).toHaveBeenCalledWith('plugin:recording|actions_ready', {})

      await act(async () => {
        pluginEvents.emit('nativeAction', { action: 'recordAudio' })
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(recorderControls.startSpy).toHaveBeenCalledTimes(1)
      expect(result.current.drawerOpen).toBe(true)

      // Confirmation waits until the recording UI has survived presentation —
      // a crash in that window must leave the action queued for next launch.
      expect(invoke).not.toHaveBeenCalledWith('plugin:recording|action_performed', {})
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(invoke).toHaveBeenCalledWith('plugin:recording|action_performed', {})
    } finally {
      vi.useRealTimers()
    }
  })

  it('unknown native actions are ignored', async () => {
    vi.useFakeTimers()
    try {
      await renderHook(() => useMobileAudioMemo(), { wrapper })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      await act(async () => {
        pluginEvents.emit('nativeAction', { action: 'somethingElse' })
        await vi.advanceTimersByTimeAsync(2000)
      })

      expect(recorderControls.startSpy).not.toHaveBeenCalled()
      expect(invoke).not.toHaveBeenCalledWith('plugin:recording|action_performed', {})
    } finally {
      vi.useRealTimers()
    }
  })

  it('without an OpenAI or Gemini model, toggle opens the drawer for key setup, never the mic', async () => {
    SETTINGS.current = {
      aiProviders: [
        {
          id: 'claude',
          provider: 'anthropic',
          model: 'claude-fable-5',
          keyHint: 'wxyz1',
        },
      ],
      defaultAiProviderId: 'claude',
      transcriptionFormat: true,
    }
    const { result } = await renderHook(() => useMobileAudioMemo(), {
      wrapper,
    })

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
