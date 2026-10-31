import { beforeEach, describe, expect, it } from 'vitest'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import type { AudioRecorderSegment, AudioRecorderState } from './audio-recorder-service.ts'
import { createWebAudioRecorder, type WebMediaDevices } from './web-audio-recorder.ts'

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static supported = ['audio/mp4']
  static failConstruction = false
  /**
   * While true, `stop()` flushes but withholds `onstop` until released.
   */
  static holdStop = false

  static isTypeSupported(type: string): boolean {
    return this.supported.includes(type)
  }

  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  state: RecordingState = 'inactive'
  stopCalls = 0
  readonly mimeType: string
  #heldStop: (() => void) | null = null

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
      this.#heldStop = () => this.onstop?.()
      return
    }
    this.onstop?.()
  }

  releaseStop(): void {
    const held = this.#heldStop
    this.#heldStop = null
    held?.()
  }
}

interface FakeTrack {
  stopped: boolean
  stop(): void
}

function fakeTrack(): FakeTrack {
  return {
    stopped: false,
    stop() {
      this.stopped = true
    },
  }
}

function fakeStream(tracks: FakeTrack[]): MediaStream {
  // Only `getTracks` is read.
  return { getTracks: () => tracks } as unknown as MediaStream
}

interface FakeMediaDevices extends WebMediaDevices {
  requests: number
  answer: () => Promise<MediaStream>
}

function fakeMediaDevices(): FakeMediaDevices {
  const devices: FakeMediaDevices = {
    requests: 0,
    answer: () => Promise.resolve(fakeStream([fakeTrack()])),
    getUserMedia() {
      devices.requests += 1
      return devices.answer()
    },
  }
  return devices
}

const START_OPTIONS = { segmentMs: Infinity, reminderMs: Infinity }

let clock: TestClockService
let mediaDevices: FakeMediaDevices

function createRecorder() {
  return createWebAudioRecorder({ clock, mediaDevices, MediaRecorder: FakeMediaRecorder })
}

beforeEach(() => {
  FakeMediaRecorder.instances = []
  FakeMediaRecorder.supported = ['audio/mp4']
  FakeMediaRecorder.failConstruction = false
  FakeMediaRecorder.holdStop = false
  clock = createTestClockService({ now: 1_700_000_000_000 })
  mediaDevices = fakeMediaDevices()
})

describe('createWebAudioRecorder', () => {
  it('records with the first supported container and returns the final segment', async () => {
    const track = fakeTrack()
    mediaDevices.answer = () => Promise.resolve(fakeStream([track]))
    const recorder = createRecorder()
    const states: AudioRecorderState[] = []
    const elapsed: number[] = []
    recorder.subscribeState((state) => {
      states.push(state)
    })
    recorder.subscribeLevel((event) => {
      elapsed.push(event.elapsedMs)
    })

    await expect(recorder.start(START_OPTIONS)).resolves.toEqual({
      sessionStartedMs: 1_700_000_000_000,
    })
    expect(recorder.state()).toBe('recording')
    expect(recorder.stream()).not.toBeNull()
    // WKWebView profile: webm unsupported, mp4 picked.
    expect(FakeMediaRecorder.instances[0]!.mimeType).toBe('audio/mp4')

    await clock.advance(3000)
    expect(elapsed.at(-1)).toBe(3000)

    const final = await recorder.stop()
    expect(final).toMatchObject({
      mimeType: 'audio/mp4',
      sessionStartedMs: 1_700_000_000_000,
      part: 1,
      end: true,
      durationMs: 3000,
    })
    expect(final?.audio.kind).toBe('blob')
    if (final?.audio.kind === 'blob') {
      expect(final.audio.blob.size).toBeGreaterThan(0)
    }
    expect(track.stopped).toBe(true)
    expect(recorder.stream()).toBeNull()
    expect(states).toEqual(['requesting', 'recording', 'idle'])
    expect(clock.pendingTimers()).toBe(0)
  })

  it('prefers opus-in-webm where the platform supports it', async () => {
    FakeMediaRecorder.supported = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    await createRecorder().start(START_OPTIONS)
    expect(FakeMediaRecorder.instances[0]!.mimeType).toBe('audio/webm;codecs=opus')
  })

  it('discards a sub-half-second recording as a misclick', async () => {
    const recorder = createRecorder()
    await recorder.start(START_OPTIONS)
    await clock.advance(200)

    await expect(recorder.stop()).resolves.toBeNull()
    expect(recorder.state()).toBe('idle')
  })

  it('cancel stops the tracks and discards without a result', async () => {
    const track = fakeTrack()
    mediaDevices.answer = () => Promise.resolve(fakeStream([track]))
    const recorder = createRecorder()
    await recorder.start(START_OPTIONS)

    await recorder.cancel()

    expect(recorder.state()).toBe('idle')
    expect(recorder.stream()).toBeNull()
    expect(track.stopped).toBe(true)
  })

  it('a recorder that fails to set up releases the stream and recovers to idle', async () => {
    const track = fakeTrack()
    mediaDevices.answer = () => Promise.resolve(fakeStream([track]))
    FakeMediaRecorder.failConstruction = true
    const recorder = createRecorder()

    await expect(recorder.start(START_OPTIONS)).rejects.toThrow('NotSupportedError')
    expect(track.stopped).toBe(true)
    expect(recorder.state()).toBe('idle')

    // The failure must not wedge the recorder: a later start records normally.
    FakeMediaRecorder.failConstruction = false
    mediaDevices.answer = () => Promise.resolve(fakeStream([fakeTrack()]))
    await recorder.start(START_OPTIONS)
    expect(recorder.state()).toBe('recording')
  })

  it('rethrows a permission denial and returns to idle', async () => {
    mediaDevices.answer = () => Promise.reject(new Error('Permission denied'))
    const recorder = createRecorder()

    await expect(recorder.start(START_OPTIONS)).rejects.toThrow('Permission denied')
    expect(recorder.state()).toBe('idle')
  })

  it('overlapping starts acquire a single stream', async () => {
    const pendingStream = Promise.withResolvers<MediaStream>()
    mediaDevices.answer = () => pendingStream.promise
    const recorder = createRecorder()

    const first = recorder.start(START_OPTIONS)
    const second = recorder.start(START_OPTIONS)
    pendingStream.resolve(fakeStream([fakeTrack()]))
    await Promise.all([first, second])

    expect(mediaDevices.requests).toBe(1)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(recorder.state()).toBe('recording')
  })

  it('a cancel during the permission prompt releases the stream it resolves into', async () => {
    const track = fakeTrack()
    const pendingStream = Promise.withResolvers<MediaStream>()
    mediaDevices.answer = () => pendingStream.promise
    const recorder = createRecorder()

    const pending = recorder.start(START_OPTIONS)
    expect(recorder.state()).toBe('requesting')
    await recorder.cancel()
    pendingStream.resolve(fakeStream([track]))

    await expect(pending).resolves.toBeNull()
    expect(track.stopped).toBe(true)
    expect(recorder.state()).toBe('idle')
    expect(FakeMediaRecorder.instances).toHaveLength(0)
  })

  it('concurrent stops share one in-flight result and stop the recorder once', async () => {
    const recorder = createRecorder()
    await recorder.start(START_OPTIONS)
    await clock.advance(3000)

    const [first, second] = await Promise.all([recorder.stop(), recorder.stop()])

    expect(FakeMediaRecorder.instances[0]!.stopCalls).toBe(1)
    expect(first).not.toBeNull()
    expect(second).toBe(first)
  })

  it('stop on an already-inactive recorder settles instead of throwing', async () => {
    const recorder = createRecorder()
    await recorder.start(START_OPTIONS)
    // Simulate an external stop landing first (a racing cancel).
    FakeMediaRecorder.instances[0]!.state = 'inactive'

    await expect(recorder.stop()).resolves.toBeNull()
    expect(FakeMediaRecorder.instances[0]!.stopCalls).toBe(0)
    expect(recorder.state()).toBe('idle')
  })

  it('rotates segments on the segment boundary and numbers the final one after them', async () => {
    const recorder = createRecorder()
    const segments: AudioRecorderSegment[] = []
    recorder.subscribeSegment((segment) => {
      segments.push(segment)
    })
    await recorder.start({ segmentMs: 1000, reminderMs: Infinity })

    await clock.advance(1000)
    expect(segments.map((segment) => [segment.part, segment.end])).toEqual([[1, false]])
    expect(FakeMediaRecorder.instances).toHaveLength(2)

    await clock.advance(400)
    await expect(recorder.stop()).resolves.toMatchObject({ part: 2, end: true })
  })

  it('a flush that outlives a tick does not queue extra rotations', async () => {
    const recorder = createRecorder()
    const segments: AudioRecorderSegment[] = []
    recorder.subscribeSegment((segment) => {
      segments.push(segment)
    })
    FakeMediaRecorder.holdStop = true
    await recorder.start({ segmentMs: 1000, reminderMs: Infinity })

    // Cross the boundary, then keep ticking while the first flush is stuck:
    // the segment counter cannot advance until it lands.
    await clock.advance(1000)
    await clock.advance(600)

    FakeMediaRecorder.holdStop = false
    FakeMediaRecorder.instances[0]!.releaseStop()
    await clock.advance(0)

    expect(segments).toHaveLength(1)
    // One replacement recorder, still live: not a run of near-empty stubs.
    expect(FakeMediaRecorder.instances).toHaveLength(2)
    expect(FakeMediaRecorder.instances[1]!.stopCalls).toBe(0)
  })

  it('reminds on every reminder boundary', async () => {
    const recorder = createRecorder()
    const reminders: number[] = []
    recorder.subscribeReminder((elapsedMs) => {
      reminders.push(elapsedMs)
    })
    await recorder.start({ segmentMs: Infinity, reminderMs: 1000 })

    await clock.advance(999)
    expect(reminders).toEqual([])
    await clock.advance(1)
    expect(reminders).toEqual([1000])
    await clock.advance(1000)
    expect(reminders).toEqual([1000, 2000])
  })

  it('a clock jump past several boundaries reminds once', async () => {
    const recorder = createRecorder()
    const reminders: number[] = []
    recorder.subscribeReminder((elapsedMs) => {
      reminders.push(elapsedMs)
    })
    await recorder.start({ segmentMs: Infinity, reminderMs: 1000 })

    // The machine slept through three boundaries: the wall clock jumps
    // without the tick firing in between.
    clock.setNow(clock.now() + 3000)
    await clock.advance(200)

    expect(reminders).toEqual([3200])
  })

  it('has no staging and no native actions', () => {
    const recorder = createRecorder()
    expect(recorder.listStaged()).toEqual([])
    expect(recorder.status()).toEqual({ recording: false, elapsedMs: 0 })
  })

  it('is supported only with both MediaRecorder and getUserMedia', () => {
    expect(createRecorder().isSupported()).toBe(true)
    // Node has neither global.
    expect(createWebAudioRecorder({ clock, MediaRecorder: FakeMediaRecorder }).isSupported()).toBe(
      false,
    )
    expect(createWebAudioRecorder({ clock, mediaDevices }).isSupported()).toBe(false)
  })
})
