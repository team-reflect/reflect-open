import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRecordingSupported, useAudioRecorder } from './use-audio-recorder'

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static supported = ['audio/mp4']
  static failConstruction = false

  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.includes(type)
  }

  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  state: RecordingState = 'inactive'
  stopCalls = 0
  readonly mimeType: string

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    if (FakeMediaRecorder.failConstruction) {
      throw new Error('NotSupportedError')
    }
    this.mimeType = options?.mimeType ?? ''
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.stopCalls += 1
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['audio-bytes']) })
    this.onstop?.()
  }
}

interface FakeTrack {
  stop: () => void
}

function fakeStream(tracks: FakeTrack[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream
}

const getUserMedia = vi.fn<() => Promise<MediaStream>>()

beforeEach(() => {
  FakeMediaRecorder.instances = []
  FakeMediaRecorder.supported = ['audio/mp4']
  FakeMediaRecorder.failConstruction = false
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  getUserMedia.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useAudioRecorder', () => {
  it('records with the first supported container and assembles the result', async () => {
    const track = { stop: vi.fn() }
    getUserMedia.mockResolvedValue(fakeStream([track]))
    const { result } = renderHook(() => useAudioRecorder())

    await act(async () => {
      await result.current.start()
    })
    expect(result.current.status).toBe('recording')
    expect(result.current.stream).not.toBeNull()
    // WKWebView profile: webm unsupported, mp4 picked.
    expect(FakeMediaRecorder.instances[0]!.mimeType).toBe('audio/mp4')

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current.elapsedMs).toBe(3000)

    const recording = await act(async () => result.current.stop())
    expect(recording).not.toBeNull()
    expect(recording?.mimeType).toBe('audio/mp4')
    expect(recording?.durationMs).toBe(3000)
    expect(recording?.blob.size).toBeGreaterThan(0)
    expect(track.stop).toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
    expect(result.current.elapsedMs).toBe(0)
  })

  it('prefers opus-in-webm where the platform supports it', async () => {
    FakeMediaRecorder.supported = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    getUserMedia.mockResolvedValue(fakeStream([{ stop: vi.fn() }]))
    const { result } = renderHook(() => useAudioRecorder())

    await act(async () => {
      await result.current.start()
    })
    expect(FakeMediaRecorder.instances[0]!.mimeType).toBe('audio/webm;codecs=opus')
  })

  it('discards a sub-half-second recording as a misclick', async () => {
    getUserMedia.mockResolvedValue(fakeStream([{ stop: vi.fn() }]))
    const { result } = renderHook(() => useAudioRecorder())

    await act(async () => {
      await result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    const recording = await act(async () => result.current.stop())
    expect(recording).toBeNull()
    expect(result.current.status).toBe('idle')
  })

  it('cancel stops the tracks and discards without a result', async () => {
    const track = { stop: vi.fn() }
    getUserMedia.mockResolvedValue(fakeStream([track]))
    const { result } = renderHook(() => useAudioRecorder())

    await act(async () => {
      await result.current.start()
    })
    act(() => {
      result.current.cancel()
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.stream).toBeNull()
    expect(track.stop).toHaveBeenCalled()
  })

  it('a recorder that fails to set up releases the stream and recovers to idle', async () => {
    const track = { stop: vi.fn() }
    getUserMedia.mockResolvedValue(fakeStream([track]))
    FakeMediaRecorder.failConstruction = true
    const { result } = renderHook(() => useAudioRecorder())

    // Catch inside act: a rejection crossing the act boundary breaks the
    // shared act scope for every later call.
    let failure: unknown = null
    await act(async () => {
      await result.current.start().catch((cause: unknown) => {
        failure = cause
      })
    })
    expect(failure).toBeInstanceOf(Error)
    expect(track.stop).toHaveBeenCalled()
    expect(result.current.status).toBe('idle')

    // The failure must not wedge the hook: a later start records normally.
    FakeMediaRecorder.failConstruction = false
    const freshTrack = { stop: vi.fn() }
    getUserMedia.mockResolvedValue(fakeStream([freshTrack]))
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.status).toBe('recording')
  })

  it('rethrows a permission denial and returns to idle', async () => {
    getUserMedia.mockRejectedValue(new Error('Permission denied'))
    const { result } = renderHook(() => useAudioRecorder())

    await expect(
      act(async () => {
        await result.current.start()
      }),
    ).rejects.toThrow('Permission denied')
    expect(result.current.status).toBe('idle')
  })

  it('overlapping starts acquire a single stream', async () => {
    const track = { stop: vi.fn() }
    let release: (stream: MediaStream) => void = () => {}
    getUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          release = resolve
        }),
    )
    const { result } = renderHook(() => useAudioRecorder())

    let firstStart: Promise<void> = Promise.resolve()
    let secondStart: Promise<void> = Promise.resolve()
    act(() => {
      firstStart = result.current.start()
      secondStart = result.current.start()
    })
    await act(async () => {
      release(fakeStream([track]))
      await Promise.all([firstStart, secondStart])
    })

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(result.current.status).toBe('recording')
  })

  it('a cancel during the permission prompt releases the stream it resolves into', async () => {
    const track = { stop: vi.fn() }
    let release: (stream: MediaStream) => void = () => {}
    getUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          release = resolve
        }),
    )
    const { result } = renderHook(() => useAudioRecorder())

    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = result.current.start()
    })
    expect(result.current.status).toBe('requesting')
    act(() => {
      result.current.cancel()
    })
    await act(async () => {
      release(fakeStream([track]))
      await pending
    })
    expect(track.stop).toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
    expect(FakeMediaRecorder.instances).toHaveLength(0)
  })

  it('concurrent stops share one in-flight result and stop the recorder once', async () => {
    getUserMedia.mockResolvedValue(fakeStream([{ stop: vi.fn() }]))
    const { result } = renderHook(() => useAudioRecorder())

    await act(async () => {
      await result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(3000)
    })

    const [first, second] = await act(async () => {
      const racingStop = result.current.stop()
      const racingStopTwin = result.current.stop()
      return Promise.all([racingStop, racingStopTwin])
    })

    expect(FakeMediaRecorder.instances[0]!.stopCalls).toBe(1)
    expect(first).not.toBeNull()
    expect(second).toBe(first)
  })

  it('stop on an already-inactive recorder settles instead of throwing', async () => {
    getUserMedia.mockResolvedValue(fakeStream([{ stop: vi.fn() }]))
    const { result } = renderHook(() => useAudioRecorder())

    await act(async () => {
      await result.current.start()
    })
    // Simulate an external stop landing first (a racing cancel).
    FakeMediaRecorder.instances[0]!.state = 'inactive'

    const recording = await act(async () => result.current.stop())

    expect(recording).toBeNull()
    expect(FakeMediaRecorder.instances[0]!.stopCalls).toBe(0)
    expect(result.current.status).toBe('idle')
  })

  it('fires onMaxDuration once when the cap is reached', async () => {
    getUserMedia.mockResolvedValue(fakeStream([{ stop: vi.fn() }]))
    const onMaxDuration = vi.fn()
    const { result } = renderHook(() =>
      useAudioRecorder({ maxDurationMs: 1000, onMaxDuration }),
    )

    await act(async () => {
      await result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(onMaxDuration).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(onMaxDuration).toHaveBeenCalledTimes(1)
  })

  it('stopping before the cap disarms it', async () => {
    getUserMedia.mockResolvedValue(fakeStream([{ stop: vi.fn() }]))
    const onMaxDuration = vi.fn()
    const { result } = renderHook(() =>
      useAudioRecorder({ maxDurationMs: 1000, onMaxDuration }),
    )

    await act(async () => {
      await result.current.start()
    })
    await act(async () => {
      await result.current.stop()
    })
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(onMaxDuration).not.toHaveBeenCalled()
  })

  it('unmount releases the microphone', async () => {
    const track = { stop: vi.fn() }
    getUserMedia.mockResolvedValue(fakeStream([track]))
    const { result, unmount } = renderHook(() => useAudioRecorder())

    await act(async () => {
      await result.current.start()
    })
    unmount()
    expect(track.stop).toHaveBeenCalled()
  })
})

describe('isRecordingSupported', () => {
  it('requires both MediaRecorder and getUserMedia', () => {
    expect(isRecordingSupported()).toBe(true)
    vi.stubGlobal('navigator', {})
    expect(isRecordingSupported()).toBe(false)
  })
})
