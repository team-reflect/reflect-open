import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { createUpdateController, type UpdateController } from './update-controller'

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))

const checkMock = vi.mocked(check)
const relaunchMock = vi.mocked(relaunch)

type DownloadHandler = Parameters<
  NonNullable<Awaited<ReturnType<typeof check>>>['downloadAndInstall']
>[0]

function fakeUpdate(overrides: { version?: string; install?: (onEvent?: DownloadHandler) => Promise<void> } = {}) {
  return {
    version: overrides.version ?? '0.2.0',
    downloadAndInstall: vi.fn(overrides.install ?? (() => Promise.resolve())),
  } as unknown as NonNullable<Awaited<ReturnType<typeof check>>>
}

describe('createUpdateController', () => {
  let controller: UpdateController | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    checkMock.mockReset()
    relaunchMock.mockReset()
  })

  afterEach(() => {
    controller?.dispose()
    controller = null
    vi.useRealTimers()
  })

  it('starts idle and stays idle when auto-check is off', () => {
    controller = createUpdateController({ autoCheck: false })
    controller.start()
    expect(controller.getState()).toEqual({ phase: 'idle' })
    expect(checkMock).not.toHaveBeenCalled()
  })

  it('auto-check finds an update and lands on available', async () => {
    checkMock.mockResolvedValue(fakeUpdate({ version: '0.3.0' }))
    controller = createUpdateController({ autoCheck: true })
    controller.start()
    await vi.waitFor(() => {
      expect(controller?.getState()).toEqual({ phase: 'available', version: '0.3.0' })
    })
  })

  it('auto-check failures are silent — back to idle, app unaffected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    checkMock.mockRejectedValue(new Error('offline'))
    controller = createUpdateController({ autoCheck: true })
    controller.start()
    await vi.waitFor(() => {
      expect(controller?.getState()).toEqual({ phase: 'idle' })
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('auto-check repeats on the interval', async () => {
    checkMock.mockResolvedValue(null)
    controller = createUpdateController({ autoCheck: true, autoCheckIntervalMs: 1000 })
    controller.start()
    await vi.waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(2000)
    expect(checkMock).toHaveBeenCalledTimes(3)
  })

  it('manual check surfaces up-to-date and errors', async () => {
    controller = createUpdateController({ autoCheck: false })
    checkMock.mockResolvedValue(null)
    await controller.checkNow()
    expect(controller.getState()).toEqual({ phase: 'upToDate' })

    checkMock.mockRejectedValue(new Error('release endpoint unreachable'))
    await controller.checkNow()
    expect(controller.getState()).toEqual({
      phase: 'error',
      message: 'release endpoint unreachable',
      during: 'check',
    })
  })

  it('install reports progress and lands on ready', async () => {
    const states: string[] = []
    checkMock.mockResolvedValue(
      fakeUpdate({
        version: '0.3.0',
        install: async (onEvent) => {
          onEvent?.({ event: 'Started', data: { contentLength: 200 } })
          onEvent?.({ event: 'Progress', data: { chunkLength: 100 } })
          onEvent?.({ event: 'Finished' })
        },
      }),
    )
    controller = createUpdateController({ autoCheck: false })
    controller.subscribe(() => {
      const state = controller?.getState()
      if (state?.phase === 'downloading') {
        states.push(`downloading:${state.percent}`)
      }
    })
    await controller.checkNow()
    await controller.install()
    expect(states).toContain('downloading:50')
    expect(states).toContain('downloading:100')
    expect(controller.getState()).toEqual({ phase: 'ready', version: '0.3.0' })
  })

  it('a rejected payload (bad signature) surfaces as a plain error', async () => {
    checkMock.mockResolvedValue(
      fakeUpdate({ install: () => Promise.reject(new Error('signature verification failed')) }),
    )
    controller = createUpdateController({ autoCheck: false })
    await controller.checkNow()
    await controller.install()
    expect(controller.getState()).toEqual({
      phase: 'error',
      message: 'signature verification failed',
      during: 'install',
    })
  })

  it('a check resolving after an install starts cannot clobber the download', async () => {
    checkMock.mockResolvedValueOnce(fakeUpdate({ version: '0.3.0' }))
    controller = createUpdateController({ autoCheck: false })
    await controller.checkNow()

    // A second check hangs in flight while the found update gets installed.
    let resolveSecond: (value: null) => void = () => {}
    checkMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve
        }),
    )
    const second = controller.checkNow()
    await controller.install()
    expect(controller.getState()).toEqual({ phase: 'ready', version: '0.3.0' })

    resolveSecond(null)
    await second
    expect(controller.getState()).toEqual({ phase: 'ready', version: '0.3.0' })
  })

  it('a silent re-check answering "no update" keeps an already-found update available', async () => {
    checkMock.mockResolvedValueOnce(fakeUpdate({ version: '0.3.0' }))
    controller = createUpdateController({ autoCheck: true, autoCheckIntervalMs: 1000 })
    controller.start()
    await vi.waitFor(() => {
      expect(controller?.getState()).toEqual({ phase: 'available', version: '0.3.0' })
    })

    // e.g. the release is mid-edit and the manifest transiently lists nothing.
    checkMock.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(1500)
    expect(controller.getState()).toEqual({ phase: 'available', version: '0.3.0' })

    // The found update is still installable.
    await controller.install()
    expect(controller.getState()).toEqual({ phase: 'ready', version: '0.3.0' })
  })

  it('a failed re-check keeps an already-found update available', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    checkMock.mockResolvedValueOnce(fakeUpdate({ version: '0.3.0' }))
    controller = createUpdateController({ autoCheck: true, autoCheckIntervalMs: 1000 })
    controller.start()
    await vi.waitFor(() => {
      expect(controller?.getState()).toEqual({ phase: 'available', version: '0.3.0' })
    })

    checkMock.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(1500)
    expect(controller.getState()).toEqual({ phase: 'available', version: '0.3.0' })
    warn.mockRestore()
  })

  it('install without a found update is a no-op', async () => {
    controller = createUpdateController({ autoCheck: false })
    await controller.install()
    expect(controller.getState()).toEqual({ phase: 'idle' })
  })

  it('restart relaunches into the installed update', async () => {
    relaunchMock.mockResolvedValue()
    controller = createUpdateController({ autoCheck: false })
    await controller.restart()
    expect(relaunchMock).toHaveBeenCalledTimes(1)
  })

  it('dispose stops the interval', async () => {
    checkMock.mockResolvedValue(null)
    controller = createUpdateController({ autoCheck: true, autoCheckIntervalMs: 1000 })
    controller.start()
    await vi.waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1))
    controller.dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(checkMock).toHaveBeenCalledTimes(1)
  })
})
