import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState, type ReactElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo, SaveAudioMemoInput, SaveAudioMemoOutcome, Settings } from '@reflect/core'

const saveAudioMemo = vi.hoisted(() =>
  vi.fn<(input: SaveAudioMemoInput) => Promise<SaveAudioMemoOutcome>>(),
)
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
  saveAudioMemo,
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
  saveAudioMemo.mockResolvedValue({ ok: true, text: 'memo transcript' })
})

afterEach(cleanup)

describe('AudioMemoProvider', () => {
  it('toggle records, then stops and hands the recording to the core action', async () => {
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

    expect(saveAudioMemo).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { kind: 'transcribe', audio: RECORDING.blob, mimeType: 'audio/mp4' },
        models: { models: SETTINGS.current.aiModels, defaultModelId: 'cfg-openai' },
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        generation: 3,
      }),
    )
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
    expect(saveAudioMemo).not.toHaveBeenCalled()
  })

  it('a resumable failure parks an error whose retry re-runs the returned step', async () => {
    const resumePayload = { kind: 'append' as const, text: 'memo transcript' }
    saveAudioMemo
      .mockResolvedValueOnce({ ok: false, message: 'disk full', resume: resumePayload })
      .mockResolvedValueOnce({ ok: true, text: 'memo transcript' })
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

    await act(async () => {
      result.current.retry()
    })
    await waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(saveAudioMemo).toHaveBeenCalledTimes(2)
    expect(saveAudioMemo).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: resumePayload }),
    )
  })

  it('a non-resumable failure offers no retry; discard returns to idle', async () => {
    saveAudioMemo.mockResolvedValue({ ok: false, message: 'came back empty', resume: null })
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.canRetry).toBe(false)

    act(() => {
      result.current.discard()
    })
    expect(result.current.phase).toBe('idle')
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

    await waitFor(() => expect(saveAudioMemo).toHaveBeenCalled())
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

    await waitFor(() => expect(saveAudioMemo).toHaveBeenCalled())
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
    expect(saveAudioMemo).toHaveBeenCalledTimes(1)
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

  it('a denied microphone maps to platform-appropriate guidance', async () => {
    recorderControls.failStart = new DOMException('denied', 'NotAllowedError')
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })

    await waitFor(() => expect(result.current.phase).toBe('error'))
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
    expect(saveAudioMemo).not.toHaveBeenCalled()
  })

  it('a second save cannot start while one is in flight', async () => {
    let release: (outcome: SaveAudioMemoOutcome) => void = () => {}
    saveAudioMemo
      .mockResolvedValueOnce({
        ok: false,
        message: 'disk full',
        resume: { kind: 'append', text: 'memo transcript' },
      })
      .mockImplementationOnce(
        () =>
          new Promise<SaveAudioMemoOutcome>((resolve) => {
            release = resolve
          }),
      )
    const { result } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    await act(async () => {
      result.current.toggle()
    })
    await waitFor(() => expect(result.current.phase).toBe('error'))

    // Two rapid retries: only one pipeline may run, or the note gets the
    // transcript twice.
    await act(async () => {
      result.current.retry()
      result.current.retry()
    })
    await act(async () => {
      release({ ok: true, text: 'memo transcript' })
    })
    await waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(saveAudioMemo).toHaveBeenCalledTimes(2)
  })

  it('a failure while the sidebar is collapsed surfaces through operations', async () => {
    saveAudioMemo.mockResolvedValue({ ok: false, message: 'provider down', resume: null })
    const { result, rerender } = renderHook(() => useAudioMemo(), { wrapper })

    await act(async () => {
      result.current.toggle()
    })
    sidebarState.collapsed = true
    await act(async () => {
      rerender()
    })

    await waitFor(() => expect(failOperation).toHaveBeenCalledWith('provider down'))
  })

  it('a parked error never invisibly blocks recording: toggle surfaces, then clears it', async () => {
    saveAudioMemo.mockResolvedValue({ ok: false, message: 'provider down', resume: null })
    const { result, rerender } = renderHook(() => useAudioMemo(), { wrapper })

    // Fail a save, then collapse — the error popover unmounts with the mic.
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

  it('is unavailable without an OpenAI or Gemini model, and toggle is a no-op', async () => {
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
    expect(saveAudioMemo).not.toHaveBeenCalled()
  })
})
