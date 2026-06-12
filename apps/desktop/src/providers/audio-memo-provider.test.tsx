import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState, type ReactElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AudioMemoIdentity,
  CaptureAudioMemoInput,
  CaptureAudioMemoOutcome,
  GraphInfo,
  ReconcileAudioMemosInput,
  ReconcileAudioMemosOutcome,
  Settings,
} from '@reflect/core'

const captureAudioMemo = vi.hoisted(() =>
  vi.fn<(input: CaptureAudioMemoInput) => Promise<CaptureAudioMemoOutcome>>(),
)
const reconcileAudioMemos = vi.hoisted(() =>
  vi.fn<(input: ReconcileAudioMemosInput) => Promise<ReconcileAudioMemosOutcome>>(),
)
const backUpNow = vi.hoisted(() => vi.fn<() => Promise<void>>())
const failOperation = vi.hoisted(() => vi.fn<(message: string) => void>())
const toggleSidebar = vi.hoisted(() => vi.fn())

const recorderControls = vi.hoisted(() => ({
  startSpy: vi.fn(),
  stopSpy: vi.fn(),
  cancelSpy: vi.fn(),
  stopResult: null as { blob: Blob; mimeType: string; durationMs: number } | null,
  supported: true,
  /** Park start() at 'requesting', simulating an open OS permission prompt. */
  holdStart: false,
  /** Park stop() until releaseStop, simulating MediaRecorder's async onstop. */
  holdStop: false,
  releaseStop: () => {},
  /** Make start() reject like a denied getUserMedia. */
  failStart: null as DOMException | null,
  options: null as { maxDurationMs?: number; onMaxDuration?: () => void } | null,
}))

const sidebarState = vi.hoisted(() => ({ collapsed: false }))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  captureAudioMemo,
  reconcileAudioMemos,
}))

vi.mock('@/hooks/use-audio-recorder', () => ({
  isRecordingSupported: () => recorderControls.supported,
  useAudioRecorder: (options: { maxDurationMs?: number; onMaxDuration?: () => void }) => {
    recorderControls.options = options
    const [status, setStatus] = useState<'idle' | 'requesting' | 'recording'>('idle')
    return {
      status,
      elapsedMs: 0,
      stream: null,
      start: async () => {
        recorderControls.startSpy()
        if (recorderControls.failStart !== null) {
          throw recorderControls.failStart
        }
        setStatus(recorderControls.holdStart ? 'requesting' : 'recording')
      },
      stop: async () => {
        recorderControls.stopSpy()
        if (recorderControls.holdStop) {
          await new Promise<void>((resolve) => {
            recorderControls.releaseStop = resolve
          })
        }
        setStatus('idle')
        return recorderControls.stopResult
      },
      cancel: () => {
        recorderControls.cancelSpy()
        setStatus('idle')
      },
    }
  },
}))

const SETTINGS = vi.hoisted(() => ({
  current: {
    aiModels: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.1', keyHint: 'wxyz1' }],
    defaultAiModelId: 'cfg-openai',
  },
}))

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: SETTINGS.current as unknown as Settings }),
}))
vi.mock('@/providers/sidebar-provider', () => ({
  useSidebar: () => ({ collapsed: sidebarState.collapsed, toggleSidebar }),
}))
vi.mock('@/providers/sync-provider', () => ({
  useSync: () => ({ backUpNow }),
}))
vi.mock('@/lib/provider-fetch', () => ({
  providerFetch: vi.fn(),
}))
vi.mock('@/lib/operations', () => ({
  startOperation: () => ({ progress: vi.fn(), done: vi.fn(), fail: failOperation }),
}))

const { AudioMemoProvider, useAudioMemo } = await import('./audio-memo-provider')

const GRAPH: GraphInfo = { root: '/notes', name: 'Notes', cloudSync: null, generation: 3 }

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <AudioMemoProvider graph={GRAPH}>{children}</AudioMemoProvider>
}

const RECORDING = {
  blob: new Blob(['audio'], { type: 'audio/mp4' }),
  mimeType: 'audio/mp4',
  durationMs: 4000,
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

const DRAINED: ReconcileAudioMemosOutcome = {
  pending: 0,
  transcribed: 0,
  rejected: 0,
  stopped: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  recorderControls.stopResult = RECORDING
  recorderControls.supported = true
  recorderControls.holdStart = false
  recorderControls.holdStop = false
  recorderControls.failStart = null
  recorderControls.options = null
  sidebarState.collapsed = false
  SETTINGS.current = {
    aiModels: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.1', keyHint: 'wxyz1' }],
    defaultAiModelId: 'cfg-openai',
  }
  captureAudioMemo.mockResolvedValue({ ok: true, memo: MEMO })
  reconcileAudioMemos.mockResolvedValue(DRAINED)
  backUpNow.mockResolvedValue(undefined)
})

afterEach(cleanup)

describe('AudioMemoProvider', () => {
  it('toggle records, then stops and hands the recording to the capture action', async () => {
    const { result } = renderHook(() => useAudioMemo(), { wrapper })
    expect(result.current.available).toBe(true)

    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('recording')

    await act(async () => {
      result.current.toggle()
    })
    await waitFor(() => expect(result.current.phase).toBe('idle'))

    expect(captureAudioMemo).toHaveBeenCalledWith({
      audio: RECORDING.blob,
      mimeType: 'audio/mp4',
      recordedAt: expect.any(Date),
      generation: 3,
    })
  })

  it('a saved capture commits the recording and schedules transcription', async () => {
    const { result } = renderHook(() => useAudioMemo(), { wrapper })
    await waitFor(() => expect(reconcileAudioMemos).toHaveBeenCalledTimes(1))

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await waitFor(() => expect(result.current.phase).toBe('idle'))

    // The Rust watcher only tracks markdown, so the asset write would never
    // reach the sync engine's debounce — the capture commits explicitly.
    expect(backUpNow).toHaveBeenCalled()
    expect(reconcileAudioMemos).toHaveBeenCalledTimes(2)
  })

  it('a too-short recording is discarded without saving', async () => {
    recorderControls.stopResult = null
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })

    expect(result.current.phase).toBe('idle')
    expect(captureAudioMemo).not.toHaveBeenCalled()
  })

  it('a capture failure parks an error whose retry re-runs the same recording', async () => {
    captureAudioMemo
      .mockResolvedValueOnce({ ok: false, message: 'disk full' })
      .mockResolvedValueOnce({ ok: true, memo: MEMO })
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.error).toBe('disk full')
    expect(result.current.canRetry).toBe(true)
    expect(backUpNow).not.toHaveBeenCalled()

    await act(async () => {
      result.current.retry()
    })
    await waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(captureAudioMemo).toHaveBeenCalledTimes(2)
    expect(captureAudioMemo).toHaveBeenLastCalledWith(
      expect.objectContaining({ audio: RECORDING.blob }),
    )
  })

  it('arms the recorder cap and saves when it fires', async () => {
    const { result } = renderHook(() => useAudioMemo(), { wrapper })
    expect(recorderControls.options?.maxDurationMs).toBe(10 * 60_000)

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      recorderControls.options?.onMaxDuration?.()
    })

    await waitFor(() => expect(captureAudioMemo).toHaveBeenCalled())
  })

  it('collapsing the sidebar mid-recording stops and saves', async () => {
    const { result, rerender } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('recording')

    sidebarState.collapsed = true
    await act(async () => {
      rerender()
    })

    await waitFor(() => expect(captureAudioMemo).toHaveBeenCalled())
  })

  it('the stop click commits immediately — no recording-phase gap for Esc to cancel in', async () => {
    recorderControls.holdStop = true
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    act(() => {
      void result.current.toggle()
    })
    // The recorder's stop hasn't settled, but the phase already left
    // 'recording' — cancel() is unreachable from the popover.
    expect(result.current.phase).toBe('transcribing')

    await act(async () => {
      recorderControls.releaseStop()
    })
    await waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(captureAudioMemo).toHaveBeenCalledTimes(1)
  })

  it('a mic click landing in the stop gap starts the next memo once the recorder frees', async () => {
    recorderControls.holdStop = true
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    act(() => {
      void result.current.toggle()
    })
    expect(result.current.phase).toBe('transcribing')

    // The button already reads as the idle mic — the click must not be
    // swallowed by the stop's re-entry guard.
    await act(async () => {
      result.current.toggle()
    })
    expect(recorderControls.startSpy).toHaveBeenCalledTimes(1)

    recorderControls.holdStop = false
    await act(async () => {
      recorderControls.releaseStop()
    })
    await waitFor(() => expect(result.current.phase).toBe('recording'))
    expect(recorderControls.startSpy).toHaveBeenCalledTimes(2)
    expect(captureAudioMemo).toHaveBeenCalledTimes(1)
  })

  it('a new recording can start while a capture is pending, and captures run serially in order', async () => {
    let releaseFirst: (outcome: CaptureAudioMemoOutcome) => void = () => {}
    captureAudioMemo.mockImplementationOnce(
      () =>
        new Promise<CaptureAudioMemoOutcome>((resolve) => {
          releaseFirst = resolve
        }),
    )
    const second = {
      blob: new Blob(['second'], { type: 'audio/mp4' }),
      mimeType: 'audio/mp4',
      durationMs: 2000,
    }
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('transcribing')

    // The first capture is still in flight — the mic must accept the next memo.
    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('recording')

    recorderControls.stopResult = second
    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('transcribing')
    expect(result.current.pendingCount).toBe(2)
    // Serial: the second memo waits — captures must land in recording order.
    expect(captureAudioMemo).toHaveBeenCalledTimes(1)

    await act(async () => {
      releaseFirst({ ok: true, memo: MEMO })
    })
    await waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(result.current.pendingCount).toBe(0)
    expect(captureAudioMemo).toHaveBeenCalledTimes(2)
    expect(captureAudioMemo).toHaveBeenLastCalledWith(
      expect.objectContaining({ audio: second.blob }),
    )
  })

  it('a failure parks the queue; retry lands the failed memo before the ones behind it', async () => {
    let releaseFirst: (outcome: CaptureAudioMemoOutcome) => void = () => {}
    captureAudioMemo.mockImplementationOnce(
      () =>
        new Promise<CaptureAudioMemoOutcome>((resolve) => {
          releaseFirst = resolve
        }),
    )
    const second = {
      blob: new Blob(['second'], { type: 'audio/mp4' }),
      mimeType: 'audio/mp4',
      durationMs: 2000,
    }
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    recorderControls.stopResult = second
    await act(async () => {
      result.current.toggle()
    })

    await act(async () => {
      releaseFirst({ ok: false, message: 'disk full' })
    })
    await waitFor(() => expect(result.current.phase).toBe('error'))
    // The second memo holds behind the failure — retrying later must not
    // write the first recording after the second.
    expect(captureAudioMemo).toHaveBeenCalledTimes(1)

    await act(async () => {
      result.current.retry()
    })
    await waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(captureAudioMemo).toHaveBeenCalledTimes(3)
    expect(captureAudioMemo.mock.calls[1]?.[0].audio).toBe(RECORDING.blob)
    expect(captureAudioMemo.mock.calls[2]?.[0].audio).toBe(second.blob)
  })

  it('discarding a failed memo releases the queue behind it', async () => {
    let releaseFirst: (outcome: CaptureAudioMemoOutcome) => void = () => {}
    captureAudioMemo.mockImplementationOnce(
      () =>
        new Promise<CaptureAudioMemoOutcome>((resolve) => {
          releaseFirst = resolve
        }),
    )
    const second = {
      blob: new Blob(['second'], { type: 'audio/mp4' }),
      mimeType: 'audio/mp4',
      durationMs: 2000,
    }
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    recorderControls.stopResult = second
    await act(async () => {
      result.current.toggle()
    })

    await act(async () => {
      releaseFirst({ ok: false, message: 'disk full' })
    })
    await waitFor(() => expect(result.current.phase).toBe('error'))

    await act(async () => {
      result.current.discard()
    })
    await waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(captureAudioMemo).toHaveBeenCalledTimes(2)
    expect(captureAudioMemo).toHaveBeenLastCalledWith(
      expect.objectContaining({ audio: second.blob }),
    )
  })

  it('a second toggle during the permission prompt aborts the request', async () => {
    recorderControls.holdStart = true
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('requesting')

    await act(async () => {
      result.current.toggle()
    })
    expect(recorderControls.cancelSpy).toHaveBeenCalled()
    expect(result.current.phase).toBe('idle')
  })

  it('a denied microphone maps to platform-appropriate guidance, with no retry', async () => {
    recorderControls.failStart = new DOMException('denied', 'NotAllowedError')
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })

    await waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.canRetry).toBe(false)
    // jsdom is not a Macintosh user agent — the copy must not name macOS paths.
    expect(result.current.error).toMatch(/system settings/i)
    expect(result.current.error).not.toMatch(/Privacy & Security/)
  })

  it('collapsing the sidebar during the permission prompt abandons the request', async () => {
    recorderControls.holdStart = true
    const { result, rerender } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('requesting')

    sidebarState.collapsed = true
    await act(async () => {
      rerender()
    })

    expect(recorderControls.cancelSpy).toHaveBeenCalled()
    expect(captureAudioMemo).not.toHaveBeenCalled()
  })

  it('a capture failure while the sidebar is collapsed surfaces through operations', async () => {
    captureAudioMemo.mockResolvedValue({ ok: false, message: 'disk full' })
    const { result, rerender } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    sidebarState.collapsed = true
    await act(async () => {
      rerender()
    })

    await waitFor(() => expect(failOperation).toHaveBeenCalledWith('disk full'))
  })

  it('a parked error never invisibly blocks recording: toggle surfaces, then clears it', async () => {
    captureAudioMemo.mockResolvedValue({ ok: false, message: 'disk full' })
    const { result, rerender } = renderHook(() => useAudioMemo(), { wrapper })

    // Fail a capture, then collapse — the error popover unmounts with the mic.
    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await waitFor(() => expect(result.current.phase).toBe('error'))
    sidebarState.collapsed = true
    await act(async () => {
      rerender()
    })

    // Collapsed: toggle re-surfaces the error instead of doing nothing.
    toggleSidebar.mockClear()
    await act(async () => {
      result.current.toggle()
    })
    expect(toggleSidebar).toHaveBeenCalled()
    expect(result.current.phase).toBe('error')

    // Visible: toggle acknowledges the error; the next one records.
    sidebarState.collapsed = false
    await act(async () => {
      rerender()
    })
    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('idle')
    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('recording')
  })

  it('starting from a collapsed sidebar expands it first', async () => {
    sidebarState.collapsed = true
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })

    expect(toggleSidebar).toHaveBeenCalled()
    expect(recorderControls.startSpy).toHaveBeenCalled()
  })

  it('is unavailable without an OpenAI or Gemini model, and nothing runs', async () => {
    SETTINGS.current = {
      aiModels: [
        { id: 'claude', provider: 'anthropic', model: 'claude-fable-5', keyHint: 'wxyz1' },
      ],
      defaultAiModelId: 'claude',
    }
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    expect(result.current.available).toBe(false)
    expect(result.current.unavailableReason).toMatch(/OpenAI or Gemini/)

    await act(async () => {
      result.current.toggle()
    })
    expect(result.current.phase).toBe('idle')
    expect(recorderControls.startSpy).not.toHaveBeenCalled()
    expect(reconcileAudioMemos).not.toHaveBeenCalled()
  })

  it('cancel discards the recording without saving', async () => {
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    act(() => {
      result.current.cancel()
    })

    expect(result.current.phase).toBe('idle')
    expect(recorderControls.cancelSpy).toHaveBeenCalled()
    expect(captureAudioMemo).not.toHaveBeenCalled()
  })

  it('runs a reconcile pass on mount and again on window focus', async () => {
    renderHook(() => useAudioMemo(), { wrapper })
    await waitFor(() => expect(reconcileAudioMemos).toHaveBeenCalledTimes(1))

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(reconcileAudioMemos).toHaveBeenCalledTimes(2))
  })

  it('shows the transcribing phase while a pass has memos to transcribe', async () => {
    let release: (outcome: ReconcileAudioMemosOutcome) => void = () => {}
    reconcileAudioMemos.mockImplementationOnce(
      (input) =>
        new Promise<ReconcileAudioMemosOutcome>((resolve) => {
          input.onPending?.(2)
          release = resolve
        }),
    )
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await waitFor(() => expect(result.current.phase).toBe('transcribing'))

    await act(async () => {
      release({ pending: 2, transcribed: 2, rejected: 0, stopped: null })
    })
    await waitFor(() => expect(result.current.phase).toBe('idle'))
  })

  it('a reconcile stop that needs attention surfaces once through operations', async () => {
    reconcileAudioMemos.mockResolvedValue({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'auth', message: 'openai rejected the API key (401)' },
    })
    renderHook(() => useAudioMemo(), { wrapper })

    await waitFor(() =>
      expect(failOperation).toHaveBeenCalledWith('openai rejected the API key (401)'),
    )

    // The focus retry hits the same wall — it must not toast again.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(reconcileAudioMemos).toHaveBeenCalledTimes(2))
    expect(failOperation).toHaveBeenCalledTimes(1)
  })

  it('an offline reconcile stop stays silent — the next trigger retries', async () => {
    reconcileAudioMemos.mockResolvedValue({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'network', message: 'provider down' },
    })
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await waitFor(() => expect(reconcileAudioMemos).toHaveBeenCalled())
    await waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(failOperation).not.toHaveBeenCalled()
  })
})
