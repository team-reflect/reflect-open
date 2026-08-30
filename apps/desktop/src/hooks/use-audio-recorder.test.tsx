import { act } from 'react'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRecordingSupported, useAudioRecorder } from './use-audio-recorder'

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static supported = ['audio/mp4']
  static failConstruction = false

  static isTypeSupported(type: string): boolean {
    return this.supported.includes(type)
  }

  /** While true, `stop()` flushes but withholds `onstop` until released. */
  static holdStop = false

  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  state: RecordingState = 'inactive'
  stopCalls = 0
  readonly mimeType: string
  private heldStop: (() => void) | null = null

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
    if (FakeMediaRecorder.holdStop) {
      this.heldStop = () => this.onstop?.()
      return
    }
    this.onstop?.()
  }

  releaseStop(): void {
    const held = this.heldStop
    this.heldStop = null
    held?.()
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
  FakeMediaRecorder.holdStop = false
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
    const onSegment = vi.fn()
    const { result } = await renderHook(() => useAudioRecorder({ onSegment }))

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

    const recording = await act(async () => await result.current.stop())
    expect(recording).not.toBeNull()
    expect(recording?.mimeType).toBe('audio/mp4')
    expect(recording?.durationMs).toBe(3000)
    expect(recording?.parts).toBe(1)
    expect(onSegment).toHaveBeenCalledTimes(1)
    const segment = onSegment.mock.calls[0]![0] as {
      blob: Blob
      mimeType: string
      part: number
      end: boolean
    }
    expect(segment.blob.size).toBeGreaterThan(0)
    expect(segment.mimeType).toBe('audio/mp4')
    expect(segment.part).toBe(1)
    expect(segment.end).toBe(true)
    expect(track.stop).toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
    expect(result.current.elapsedMs).toBe(0)
  })

  it('prefers opus-in-webm where the platform supports it', async () => {
    FakeMediaRecorder.supported = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    getUserMedia.mockResolvedValue(fakeStream([{ stop: vi.fn() }]))
    const { result } = await renderHook(() => useAudioRecorder())

    await act(async () => {
      await result.current.start()
    })
    expect(FakeMediaRecorder.instances[0]!.mimeType).toBe('audio/webm;codecs=opus')
  })

  it('discards a sub-half-second recording as a misclick', async () => {
    getUserMedia.mockResolvedValue(fakeStream([{ stop: vi.fn() }]))
    const { result } = await renderHook(() => useAudioRecorder())

    await act(async () => {
      await result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    const recording = await act(async () => await result.current.stop())
    expect(recording).toBeNull()
    expect(result.current.status).toBe('idle')
  })

  it('cancel stops the tracks and discards without a result', async () => {
    const track = { stop: vi.fn() }
    getUserMedia.mockResolvedValue(fakeStream([track]))
    const { result } = await renderHook(() => useAudioRecorder())

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
    const { result } = await renderHook(() => useAudioRecorder())

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
    const { result } = await renderHook(() => useAudioRecorder())

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
    const { result } = await renderHook(() => useAudioRecorder())

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
    const { result } = await renderHook(() => useAudioRecorder())

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
    const { result } = await renderHook(() => useAudioRecorder())

    await act(async () => {
      await result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(3000)
    })

    const [first, second] = await act(async () => {
      const racingStop = result.current.stop()
      const racingStopTwin = result.current.stop()
      return await Promise.all([racingStop, racingStopTwin])
    })

    expect(FakeMediaRecorder.instances[0]!.stopCalls).toBe(1)
    expect(first).not.toBeNull()
    expect(second).toBe(first)
  })

  it('stop on an already-inactive recorder settles instead of throwing', async () => {
    getUserMedia.mockResolvedValue(fakeStream([{ stop: vi.fn() }]))
    const { result } = await renderHook(() => useAudioRecorder())

    await act(async () => {
      await result.current.start()
    })
    // Simulate an external stop landing first (a racing cancel).
    FakeMediaRecorder.instances[0]!.state = 'inactive'

    const recording = await act(async () => await result.current.stop())

    expect(recording).toBeNull()
    expect(FakeMediaRecorder.instances[0]!.stopCalls).toBe(0)
    expect(result.current.status).toBe('idle')
  })

  it('a flush that outlives a tick does not queue extra rotations', async () => {
    getUserMedia.mockResolvedValue(fakeStream([{ stop: vi.fn() }]))
    const onSegment = vi.fn()
    FakeMediaRecorder.holdStop = true
    const { result } = await renderHook(() => useAudioRecorder({ segmentMs: 1000, onSegment }))

    await act(async () => {
      await result.current.start()
    })
    // Cross the boundary, then keep ticking while the first flush is stuck:
    // the segment counter cannot advance until it lands.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })

    FakeMediaRecorder.holdStop = false
    await act(async () => {
      FakeMediaRecorder.instances[0]!.releaseStop()
    })

    expect(onSegment).toHaveBeenCalledTimes(1)
    // One replacement recorder, still live — not a run of near-empty stubs.
    expect(FakeMediaRecorder.instances).toHaveLength(2)
    expect(FakeMediaRecorder.instances[1]!.stopCalls).toBe(0)
  })

  it('reminds the user on every interval boundary', async () => {
    getUserMedia.mockResolvedValue(fakeStream([{ stop: vi.fn() }]))
    const onReminder = vi.fn()
    const { result } = await renderHook(() => useAudioRecorder({ reminderMs: 1000, onReminder }))

    await act(async () => {
      await result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(onReminder).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onReminder).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onReminder).toHaveBeenCalledTimes(2)
  })

  it('a clock jump past several boundaries reminds once', async () => {
    getUserMedia.mockResolvedValue(fakeStream([{ stop: vi.fn() }]))
    const onReminder = vi.fn()
    const { result } = await renderHook(() => useAudioRecorder({ reminderMs: 1000, onReminder }))

    await act(async () => {
      await result.current.start()
    })
    // The machine slept through three boundaries: the elapsed clock jumps
    // without the tick firing in between.
    act(() => {
      vi.setSystemTime(Date.now() + 3000)
      vi.advanceTimersByTime(200)
    })

    expect(onReminder).toHaveBeenCalledTimes(1)
    expect(onReminder).toHaveBeenCalledWith(3200)
  })

  it('unmount releases the microphone', async () => {
    const track = { stop: vi.fn() }
    getUserMedia.mockResolvedValue(fakeStream([track]))
    const { result, unmount } = await renderHook(() => useAudioRecorder())

    await act(async () => {
      await result.current.start()
    })
    await unmount()
    expect(track.stop).toHaveBeenCalled()
  })
})

describe('isRecordingSupported', () => {
  it('requires both MediaRecorder and getUserMedia', async () => {
    expect(isRecordingSupported()).toBe(true)
    vi.stubGlobal('navigator', {})
    expect(isRecordingSupported()).toBe(false)
  })
})
