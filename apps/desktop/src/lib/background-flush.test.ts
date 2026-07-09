import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBackgroundFlush } from './background-flush'

/**
 * The Plan 19 decision-6 contract: backgrounding the app mid-edit (inside the
 * save debounce) must land the buffers on disk and then make a local backup
 * commit — that sequence is what makes "kill the app from the switcher,
 * relaunch, the edit is there" hold. These tests pin the trigger (hidden, not
 * visible), the ordering (commit only after buffers/settings settle), and the
 * never-blocks guarantees (a failed flush still commits).
 */

const seams = vi.hoisted(() => ({
  beginBackgroundTask: vi.fn<() => Promise<string | null>>(async () => 'background-task-1'),
  endBackgroundTask: vi.fn<(token: string) => Promise<void>>(async () => {}),
  flushOpenDocuments: vi.fn<() => Promise<void>>(async () => {}),
  flushSettings: vi.fn<() => Promise<void>>(async () => {}),
  flushBackup: vi.fn<() => Promise<void>>(async () => {}),
}))
vi.mock('@reflect/core', () => ({
  beginBackgroundTask: seams.beginBackgroundTask,
  endBackgroundTask: seams.endBackgroundTask,
}))
vi.mock('@/editor/open-documents', () => ({ flushOpenDocuments: seams.flushOpenDocuments }))
vi.mock('@/lib/settings-flush', () => ({ flushSettings: seams.flushSettings }))
vi.mock('@/lib/backup-flush', () => ({ flushBackup: seams.flushBackup }))

let visibility: DocumentVisibilityState
let dispose: (() => void) | null = null

/** Wait for chained `.then` callbacks to run. */
async function settleMicrotasks(): Promise<void> {
  for (let iteration = 0; iteration < 8; iteration += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
  seams.beginBackgroundTask.mockClear().mockImplementation(async () => 'background-task-1')
  seams.endBackgroundTask.mockClear().mockImplementation(async () => {})
  seams.flushOpenDocuments.mockClear().mockImplementation(async () => {})
  seams.flushSettings.mockClear().mockImplementation(async () => {})
  seams.flushBackup.mockClear().mockImplementation(async () => {})
})

afterEach(() => {
  dispose?.()
  dispose = null
})

function goHidden(): void {
  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
}

function goVisible(): void {
  visibility = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('installBackgroundFlush', () => {
  it('protects documents, settings, and the commit with one balanced assertion', async () => {
    dispose = installBackgroundFlush()

    goHidden()
    await settleMicrotasks()

    expect(seams.beginBackgroundTask).toHaveBeenCalledTimes(1)
    expect(seams.flushOpenDocuments).toHaveBeenCalledTimes(1)
    expect(seams.flushSettings).toHaveBeenCalledTimes(1)
    expect(seams.flushBackup).toHaveBeenCalledTimes(1)
    expect(seams.endBackgroundTask).toHaveBeenCalledWith('background-task-1')
    expect(seams.beginBackgroundTask.mock.invocationCallOrder[0]).toBeLessThan(
      seams.flushOpenDocuments.mock.invocationCallOrder[0] ?? 0,
    )
    expect(seams.flushBackup.mock.invocationCallOrder[0]).toBeLessThan(
      seams.endBackgroundTask.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('commits only after the buffers have landed (the mid-debounce edit)', async () => {
    let landBuffers: () => void = () => {}
    seams.flushOpenDocuments.mockImplementation(
      () =>
        new Promise((resolve) => {
          landBuffers = resolve
        }),
    )
    dispose = installBackgroundFlush()

    goHidden()
    await settleMicrotasks()
    // The note write is still in flight — a commit now would miss the edit.
    expect(seams.flushBackup).not.toHaveBeenCalled()

    landBuffers()
    await settleMicrotasks()
    expect(seams.flushBackup).toHaveBeenCalledTimes(1)
  })

  it('still commits when a buffer flush fails (backgrounding never blocks)', async () => {
    seams.flushOpenDocuments.mockImplementation(async () => {
      throw new Error('disk full')
    })
    dispose = installBackgroundFlush()

    goHidden()
    await settleMicrotasks()

    expect(seams.flushBackup).toHaveBeenCalledTimes(1)
    expect(seams.endBackgroundTask).toHaveBeenCalledTimes(1)
  })

  it('ends the assertion even when a flush step unexpectedly rejects', async () => {
    seams.flushBackup.mockRejectedValueOnce(new Error('commit failed'))
    dispose = installBackgroundFlush()

    goHidden()
    await settleMicrotasks()

    expect(seams.endBackgroundTask).toHaveBeenCalledWith('background-task-1')
  })

  it('still flushes when native background time is unavailable', async () => {
    seams.beginBackgroundTask.mockRejectedValueOnce(new Error('no native bridge'))
    dispose = installBackgroundFlush()

    goHidden()
    await settleMicrotasks()

    expect(seams.flushOpenDocuments).toHaveBeenCalledTimes(1)
    expect(seams.flushBackup).toHaveBeenCalledTimes(1)
    expect(seams.endBackgroundTask).not.toHaveBeenCalled()
  })

  it('does not end a task when the native shell returns no assertion', async () => {
    seams.beginBackgroundTask.mockResolvedValueOnce(null)
    dispose = installBackgroundFlush()

    goHidden()
    await settleMicrotasks()

    expect(seams.flushOpenDocuments).toHaveBeenCalledTimes(1)
    expect(seams.flushBackup).toHaveBeenCalledTimes(1)
    expect(seams.endBackgroundTask).not.toHaveBeenCalled()
  })

  it('does nothing on becoming visible', async () => {
    dispose = installBackgroundFlush()

    document.dispatchEvent(new Event('visibilitychange'))
    await settleMicrotasks()

    expect(seams.flushOpenDocuments).not.toHaveBeenCalled()
    expect(seams.flushBackup).not.toHaveBeenCalled()
  })

  it('also flushes on pagehide (webview teardown)', async () => {
    dispose = installBackgroundFlush()

    window.dispatchEvent(new Event('pagehide'))
    await settleMicrotasks()

    expect(seams.flushOpenDocuments).toHaveBeenCalledTimes(1)
    expect(seams.flushBackup).toHaveBeenCalledTimes(1)
  })

  it('coalesces visibilitychange and pagehide from one background transition', async () => {
    let landBuffers: () => void = () => {}
    seams.flushOpenDocuments.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          landBuffers = resolve
        }),
    )
    dispose = installBackgroundFlush()

    goHidden()
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('pagehide'))
    await settleMicrotasks()
    // Only the first chain is running — nothing concurrent.
    expect(seams.flushOpenDocuments).toHaveBeenCalledTimes(1)
    expect(seams.flushBackup).not.toHaveBeenCalled()

    landBuffers()
    await settleMicrotasks()
    expect(seams.flushOpenDocuments).toHaveBeenCalledTimes(1)
    expect(seams.flushBackup).toHaveBeenCalledTimes(1)
    expect(seams.beginBackgroundTask).toHaveBeenCalledTimes(1)
  })

  it('queues one rerun for a genuine visible-to-hidden transition in flight', async () => {
    let landBuffers: () => void = () => {}
    seams.flushOpenDocuments.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          landBuffers = resolve
        }),
    )
    dispose = installBackgroundFlush()

    goHidden()
    goVisible()
    goHidden()
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('pagehide'))
    await settleMicrotasks()
    expect(seams.flushOpenDocuments).toHaveBeenCalledTimes(1)

    landBuffers()
    await settleMicrotasks()
    await settleMicrotasks()
    expect(seams.flushOpenDocuments).toHaveBeenCalledTimes(2)
    expect(seams.flushBackup).toHaveBeenCalledTimes(2)
    expect(seams.beginBackgroundTask).toHaveBeenCalledTimes(2)
  })

  it('stops listening after dispose', async () => {
    dispose = installBackgroundFlush()
    dispose()
    dispose = null

    goHidden()
    window.dispatchEvent(new Event('pagehide'))
    await settleMicrotasks()

    expect(seams.flushOpenDocuments).not.toHaveBeenCalled()
    expect(seams.flushBackup).not.toHaveBeenCalled()
  })
})
