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
  flushOpenDocuments: vi.fn<() => Promise<void>>(async () => {}),
  flushSettings: vi.fn<() => Promise<void>>(async () => {}),
  flushBackup: vi.fn<() => Promise<void>>(async () => {}),
}))
vi.mock('@/editor/open-documents', () => ({ flushOpenDocuments: seams.flushOpenDocuments }))
vi.mock('@/lib/settings-flush', () => ({ flushSettings: seams.flushSettings }))
vi.mock('@/lib/backup-flush', () => ({ flushBackup: seams.flushBackup }))

let visibility: DocumentVisibilityState
let dispose: (() => void) | null = null

/** Wait for chained `.then` callbacks to run. */
async function settleMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
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

describe('installBackgroundFlush', () => {
  it('flushes documents and settings, then commits, when the app hides', async () => {
    dispose = installBackgroundFlush()

    goHidden()
    await settleMicrotasks()

    expect(seams.flushOpenDocuments).toHaveBeenCalledTimes(1)
    expect(seams.flushSettings).toHaveBeenCalledTimes(1)
    expect(seams.flushBackup).toHaveBeenCalledTimes(1)
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

  it('coalesces simultaneous triggers into one flush chain', async () => {
    // iOS fires visibilitychange AND pagehide on one backgrounding; two
    // chains would race the same buffers and git index.
    let landBuffers: () => void = () => {}
    seams.flushOpenDocuments.mockImplementation(
      () =>
        new Promise((resolve) => {
          landBuffers = resolve
        }),
    )
    dispose = installBackgroundFlush()

    goHidden()
    window.dispatchEvent(new Event('pagehide'))
    landBuffers()
    await settleMicrotasks()

    expect(seams.flushOpenDocuments).toHaveBeenCalledTimes(1)
    expect(seams.flushBackup).toHaveBeenCalledTimes(1)

    // A later, separate backgrounding flushes again (once the first chain
    // has fully settled and released the in-flight slot).
    await settleMicrotasks()
    seams.flushOpenDocuments.mockImplementation(async () => {})
    window.dispatchEvent(new Event('pagehide'))
    await settleMicrotasks()
    expect(seams.flushBackup).toHaveBeenCalledTimes(2)
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
