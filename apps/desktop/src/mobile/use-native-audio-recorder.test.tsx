import { act } from 'react'
import { renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import {
  isStagedPathClaimed,
  releaseStagedPath,
  useNativeAudioRecorder,
} from './use-native-audio-recorder'

const invoke = vi.fn<(command: string, args?: unknown) => Promise<unknown>>()

/** Captured plugin-event handlers, keyed by event name, dispatchable per test. */
const pluginEvents = {
  handlers: new Map<string, (payload: unknown) => void>(),
  emit(event: string, payload: unknown): void {
    pluginEvents.handlers.get(event)?.(payload)
  },
}

const onSegment = vi.fn()
const onNativeStop = vi.fn()

/** Every session in these tests starts here; its segments share the stamp. */
const SESSION_STARTED_MS = 1_700_000_000_000

async function renderRecorder() {
  return await renderHook(() =>
    useNativeAudioRecorder({
      segmentMs: 20 * 60_000,
      reminderMs: 30 * 60_000,
      onSegment,
      onNativeStop,
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  pluginEvents.handlers.clear()
  invoke.mockResolvedValue({ sessionStartedMs: SESSION_STARTED_MS })
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
})

afterEach(() => {
  setBridge(null)
})

describe('useNativeAudioRecorder', () => {
  it('start invokes the plugin with the segment length and flips to recording', async () => {
    const { result } = await renderRecorder()
    expect(result.current.status).toBe('idle')

    const started: Array<Date | null> = []
    await act(async () => {
      started.push(await result.current.start())
    })

    expect(invoke).toHaveBeenCalledWith('plugin:recording|start_recording', {
      request: { segmentMs: 20 * 60_000, reminderMs: 30 * 60_000 },
    })
    expect(started[0]).toEqual(new Date(SESSION_STARTED_MS))
    expect(result.current.status).toBe('recording')
  })

  it('a rotated segment reaches onSegment and is claimed', async () => {
    const path = '/staging/recording-1700000000000.part-001.m4a'
    await renderRecorder()
    await vi.waitFor(() => expect(pluginEvents.handlers.has('recordingSegment')).toBe(true))

    act(() => {
      pluginEvents.emit('recordingSegment', {
        path,
        sessionStartedMs: SESSION_STARTED_MS,
        part: 1,
      })
    })

    expect(onSegment).toHaveBeenCalledWith({
      stagedPath: path,
      recordedAt: new Date(SESSION_STARTED_MS),
      part: 1,
      end: false,
    })
    expect(isStagedPathClaimed(path)).toBe(true)
    releaseStagedPath(path)
  })

  it('a rejected start resets to idle and rethrows for the caller', async () => {
    invoke.mockRejectedValueOnce('microphone access denied')
    const { result } = await renderRecorder()

    await expect(
      act(async () => {
        await result.current.start()
      }),
    ).rejects.toEqual({ kind: 'unknown', message: 'microphone access denied' })
    expect(result.current.status).toBe('idle')
  })

  it('stop claims the staged file and hands back its path', async () => {
    const path = '/staging/stop-normal.m4a'
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:recording|start_recording') {
        return
      }
      if (command === 'plugin:recording|stop_recording') {
        return { path, sessionStartedMs: SESSION_STARTED_MS, part: 2, durationMs: 4000 }
      }
      throw new Error(`unexpected invoke: ${command}`)
    })
    const { result } = await renderRecorder()

    await act(async () => {
      await result.current.start()
    })
    const results: Array<Awaited<ReturnType<typeof result.current.stop>>> = []
    await act(async () => {
      results.push(await result.current.stop())
    })

    const stopped = results[0]
    expect(stopped).not.toBeNull()
    expect(stopped?.stagedPath).toBe(path)
    expect(stopped?.part).toBe(2)
    expect(stopped?.end).toBe(true)
    // The memo's identity timestamp is the session's start, not wall clock.
    expect(stopped?.recordedAt).toEqual(new Date(SESSION_STARTED_MS))
    expect(isStagedPathClaimed(path)).toBe(true)
    expect(result.current.status).toBe('idle')
    releaseStagedPath(path)
  })

  it('a too-short one-segment stop deletes the staged file and returns null', async () => {
    const path = '/staging/stop-short.m4a'
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:recording|stop_recording') {
        return { path, sessionStartedMs: SESSION_STARTED_MS, part: 1, durationMs: 300 }
      }
      return { sessionStartedMs: SESSION_STARTED_MS }
    })
    const { result } = await renderRecorder()

    await act(async () => {
      await result.current.start()
    })
    let stopped: Awaited<ReturnType<typeof result.current.stop>> = null
    await act(async () => {
      stopped = await result.current.stop()
    })

    expect(stopped).toBeNull()
    expect(invoke).toHaveBeenCalledWith('plugin:recording|delete_staged', {
      request: { path },
    })
    expect(isStagedPathClaimed(path)).toBe(false)
  })

  it('level events feed the waveform only while recording', async () => {
    const { result } = await renderRecorder()
    await vi.waitFor(() => expect(pluginEvents.handlers.has('recordingLevel')).toBe(true))

    act(() => {
      pluginEvents.emit('recordingLevel', { level: 0.5, elapsedMs: 1200 })
    })
    expect(result.current.level).toBe(0)

    await act(async () => {
      await result.current.start()
    })
    act(() => {
      pluginEvents.emit('recordingLevel', { level: 0.5, elapsedMs: 1200 })
    })
    expect(result.current.level).toBe(0.5)
    expect(result.current.elapsedMs).toBe(1200)
  })

  it('a native stop hands the staged path to onNativeStop', async () => {
    const path = '/staging/native-stop.m4a'
    const { result } = await renderRecorder()
    await vi.waitFor(() => expect(pluginEvents.handlers.has('recordingStopped')).toBe(true))
    await act(async () => {
      await result.current.start()
    })

    await act(async () => {
      pluginEvents.emit('recordingStopped', {
        path,
        sessionStartedMs: SESSION_STARTED_MS,
        part: 3,
        durationMs: 5000,
        reason: 'interruption',
      })
    })

    expect(result.current.status).toBe('idle')
    await vi.waitFor(() =>
      expect(onNativeStop).toHaveBeenCalledWith({
        stagedPath: path,
        recordedAt: new Date(SESSION_STARTED_MS),
        part: 3,
        end: true,
      }),
    )
    expect(isStagedPathClaimed(path)).toBe(true)
    releaseStagedPath(path)
  })

  it('a too-short one-segment native stop deletes the file and reports null', async () => {
    const path = '/staging/native-short.m4a'
    await renderRecorder()
    await vi.waitFor(() => expect(pluginEvents.handlers.has('recordingStopped')).toBe(true))

    await act(async () => {
      pluginEvents.emit('recordingStopped', {
        path,
        sessionStartedMs: SESSION_STARTED_MS,
        part: 1,
        durationMs: 200,
        reason: 'interruption',
      })
    })

    await vi.waitFor(() => expect(onNativeStop).toHaveBeenCalledWith(null))
    expect(invoke).toHaveBeenCalledWith('plugin:recording|delete_staged', {
      request: { path },
    })
    expect(isStagedPathClaimed(path)).toBe(false)
  })

  it('a native stop landing during start does not resurrect the recording', async () => {
    const path = '/staging/stop-during-start.m4a'
    let releaseStart: () => void = () => {}
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:recording|start_recording') {
        await new Promise<void>((resolve) => {
          releaseStart = resolve
        })
        return { sessionStartedMs: SESSION_STARTED_MS }
      }
      return
    })
    const { result } = await renderRecorder()
    await vi.waitFor(() => expect(pluginEvents.handlers.has('recordingStopped')).toBe(true))

    let startPromise: Promise<Date | null> = Promise.resolve(null)
    await act(async () => {
      startPromise = result.current.start()
      await Promise.resolve()
    })
    expect(result.current.status).toBe('requesting')

    // The recorder finalizes (e.g. immediate interruption) before start's
    // invoke resolves — status must stay idle, not flip back to recording.
    await act(async () => {
      pluginEvents.emit('recordingStopped', {
        path,
        sessionStartedMs: SESSION_STARTED_MS,
        part: 1,
        durationMs: 200,
        reason: 'interruption',
      })
      releaseStart()
      await startPromise
    })

    expect(result.current.status).toBe('idle')
  })
})
