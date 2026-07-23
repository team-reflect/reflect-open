import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn<(command: string, args?: unknown) => Promise<unknown>>())

/** Captured plugin-event handlers, keyed by event name, dispatchable per test. */
const pluginEvents = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  emit(event: string, payload: unknown): void {
    pluginEvents.handlers.get(event)?.(payload)
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  addPluginListener: vi.fn(async (_plugin: string, event: string, handler: (p: unknown) => void) => {
    pluginEvents.handlers.set(event, handler)
    return { unregister: vi.fn() }
  }),
}))

const { isStagedPathClaimed, releaseStagedPath, useNativeAudioRecorder } = await import(
  './use-native-audio-recorder'
)

function base64Of(text: string): string {
  return btoa(text)
}

const onNativeStop = vi.fn()

function renderRecorder() {
  return renderHook(() =>
    useNativeAudioRecorder({ maxDurationMs: 600_000, onNativeStop }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  pluginEvents.handlers.clear()
  invoke.mockResolvedValue(undefined)
})

describe('useNativeAudioRecorder', () => {
  it('start invokes the plugin with the cap and flips to recording', async () => {
    const { result } = renderRecorder()
    expect(result.current.status).toBe('idle')

    await act(async () => {
      await result.current.start()
    })

    expect(invoke).toHaveBeenCalledWith('plugin:recording|start_recording', {
      request: { maxDurationMs: 600_000 },
    })
    expect(result.current.status).toBe('recording')
  })

  it('a rejected start resets to idle and rethrows for the caller', async () => {
    invoke.mockRejectedValueOnce('microphone access denied')
    const { result } = renderRecorder()

    await expect(
      act(async () => {
        await result.current.start()
      }),
    ).rejects.toBe('microphone access denied')
    expect(result.current.status).toBe('idle')
  })

  it('stop reads the staged file back, claims it, and returns the blob', async () => {
    const path = '/staging/stop-normal.m4a'
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:recording|start_recording') {
        return undefined
      }
      if (command === 'plugin:recording|stop_recording') {
        return { path, durationMs: 4000, modifiedMs: 1_700_000_000_000 }
      }
      if (command === 'plugin:recording|read_staged') {
        return { base64: base64Of('audio-bytes') }
      }
      throw new Error(`unexpected invoke: ${command}`)
    })
    const { result } = renderRecorder()

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
    expect(stopped?.durationMs).toBe(4000)
    expect(stopped?.mimeType).toBe('audio/mp4')
    // The memo's identity timestamp is the staged file's mtime, not wall clock.
    expect(stopped?.recordedAt).toEqual(new Date(1_700_000_000_000))
    expect(await stopped?.blob.text()).toBe('audio-bytes')
    expect(isStagedPathClaimed(path)).toBe(true)
    expect(result.current.status).toBe('idle')
    releaseStagedPath(path)
  })

  it('a too-short stop deletes the staged file and returns null', async () => {
    const path = '/staging/stop-short.m4a'
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:recording|stop_recording') {
        return { path, durationMs: 300, modifiedMs: 1_700_000_000_000 }
      }
      return undefined
    })
    const { result } = renderRecorder()

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
    const { result } = renderRecorder()
    await waitFor(() => expect(pluginEvents.handlers.has('recordingLevel')).toBe(true))

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

  it('a native stop reads the file back and hands it to onNativeStop', async () => {
    const path = '/staging/native-stop.m4a'
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:recording|read_staged') {
        return { base64: base64Of('native-bytes') }
      }
      return undefined
    })
    const { result } = renderRecorder()
    await waitFor(() => expect(pluginEvents.handlers.has('recordingStopped')).toBe(true))
    await act(async () => {
      await result.current.start()
    })

    await act(async () => {
      pluginEvents.emit('recordingStopped', {
        path,
        durationMs: 5000,
        modifiedMs: 1_700_000_000_000,
        reason: 'interruption',
      })
    })

    expect(result.current.status).toBe('idle')
    await waitFor(() =>
      expect(onNativeStop).toHaveBeenCalledWith(
        expect.objectContaining({
          stagedPath: path,
          durationMs: 5000,
          recordedAt: new Date(1_700_000_000_000),
        }),
      ),
    )
    expect(isStagedPathClaimed(path)).toBe(true)
    releaseStagedPath(path)
  })

  it('a too-short native stop deletes the file and reports null', async () => {
    const path = '/staging/native-short.m4a'
    renderRecorder()
    await waitFor(() => expect(pluginEvents.handlers.has('recordingStopped')).toBe(true))

    await act(async () => {
      pluginEvents.emit('recordingStopped', {
        path,
        durationMs: 200,
        modifiedMs: 1_700_000_000_000,
        reason: 'interruption',
      })
    })

    await waitFor(() => expect(onNativeStop).toHaveBeenCalledWith(null))
    expect(invoke).toHaveBeenCalledWith('plugin:recording|delete_staged', {
      request: { path },
    })
    expect(isStagedPathClaimed(path)).toBe(false)
  })

  it('a failed read-back after a native stop releases the claim and closes the UI', async () => {
    const path = '/staging/native-unreadable.m4a'
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:recording|read_staged') {
        throw new Error('io error')
      }
      return undefined
    })
    renderRecorder()
    await waitFor(() => expect(pluginEvents.handlers.has('recordingStopped')).toBe(true))

    await act(async () => {
      pluginEvents.emit('recordingStopped', {
        path,
        durationMs: 5000,
        modifiedMs: 1_700_000_000_000,
        reason: 'error',
      })
    })

    // The file is left staged (released) for the orphan scan, but the host is
    // still notified so the recording UI closes rather than stranding.
    await waitFor(() => expect(isStagedPathClaimed(path)).toBe(false))
    expect(onNativeStop).toHaveBeenCalledWith(null)
  })

  it('a native stop landing during start does not resurrect the recording', async () => {
    const path = '/staging/stop-during-start.m4a'
    let releaseStart: () => void = () => {}
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:recording|start_recording') {
        await new Promise<void>((resolve) => {
          releaseStart = resolve
        })
        return undefined
      }
      return undefined
    })
    const { result } = renderRecorder()
    await waitFor(() => expect(pluginEvents.handlers.has('recordingStopped')).toBe(true))

    let startPromise: Promise<void> = Promise.resolve()
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
        durationMs: 200,
        modifiedMs: 1_700_000_000_000,
        reason: 'interruption',
      })
      releaseStart()
      await startPromise
    })

    expect(result.current.status).toBe('idle')
  })
})
