import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface CloseRequestedEventForTest {
  preventDefault: () => void
}

type CloseRequestedHandler = (event: CloseRequestedEventForTest) => Promise<void>

const windowMock = vi.hoisted(() => ({
  closeRequested: null as CloseRequestedHandler | null,
  hide: vi.fn(async () => {}),
  unlisten: vi.fn(),
}))
const windowRole = vi.hoisted(() => ({ isMainWindow: true }))
const core = vi.hoisted(() => ({
  confirmQuit: vi.fn(async () => {}),
  quitRequested: null as (() => void) | null,
  unlisten: vi.fn(),
}))
const flushOpenDocuments = vi.hoisted(() => vi.fn(async () => {}))
const flushSettings = vi.hoisted(() => vi.fn(async () => {}))
const flushBackup = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    hide: windowMock.hide,
    onCloseRequested: async (handler: CloseRequestedHandler) => {
      windowMock.closeRequested = handler
      return windowMock.unlisten
    },
  }),
}))

vi.mock('@reflect/core', () => ({
  confirmQuit: core.confirmQuit,
  subscribeQuitRequested: async (handler: () => void) => {
    core.quitRequested = handler
    return core.unlisten
  },
}))

vi.mock('@/editor/open-documents.ts', () => ({ flushOpenDocuments }))
vi.mock('@/lib/backup-flush.ts', () => ({ flushBackup }))
vi.mock('@/lib/settings-flush.ts', () => ({ flushSettings }))
vi.mock('@/lib/platform.ts', () => ({ isMacosDesktop: true, isNativeShell: () => true }))
vi.mock('@/lib/windows/window-role.ts', () => ({
  isMainWindow: () => windowRole.isMainWindow,
}))

const { installQuitFlush } = await import('./quit-flush.ts')

beforeEach(() => {
  windowRole.isMainWindow = true
  windowMock.closeRequested = null
  core.quitRequested = null
})

afterEach(() => {
  vi.clearAllMocks()
})

interface CloseRequestForTest {
  completed: Promise<void>
  preventDefault: ReturnType<typeof vi.fn>
}

/**
 * Exposes synchronous close prevention separately from async persistence so
 * tests can assert that the window hides while saves are still pending.
 */
function closeCurrentWindow(): CloseRequestForTest {
  const preventDefault = vi.fn()
  const closeRequested = windowMock.closeRequested
  expect(closeRequested).not.toBeNull()
  const completed = closeRequested?.({ preventDefault }) ?? Promise.resolve()
  return { completed, preventDefault }
}

/** Lets tests control save completion order without relying on real I/O timing. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('installQuitFlush', () => {
  it.each(['documents', 'settings'])(
    'hides the main window before pending saves and backup finish (%s finish first)',
    async (firstSave) => {
      const documents = deferred()
      const settings = deferred()
      const backup = deferred()
      flushOpenDocuments.mockReturnValueOnce(documents.promise)
      flushSettings.mockReturnValueOnce(settings.promise)
      flushBackup.mockReturnValueOnce(backup.promise)
      const dispose = installQuitFlush()
      const closeRequest = closeCurrentWindow()

      try {
        expect(closeRequest.preventDefault).toHaveBeenCalledOnce()
        expect(windowMock.hide).toHaveBeenCalledOnce()
        await vi.waitFor(() => expect(flushOpenDocuments).toHaveBeenCalledOnce())
        expect(flushSettings).toHaveBeenCalledOnce()
        expect(flushBackup).not.toHaveBeenCalled()

        const first = firstSave === 'documents' ? documents : settings
        const last = firstSave === 'documents' ? settings : documents
        first.resolve()
        // Drain promise continuations so an incorrectly unblocked backup can run.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        expect(flushBackup).not.toHaveBeenCalled()
        last.resolve()
        await vi.waitFor(() => expect(flushBackup).toHaveBeenCalledOnce())
        expect(windowMock.hide).toHaveBeenCalledOnce()
      } finally {
        documents.resolve()
        settings.resolve()
        backup.resolve()
        await closeRequest.completed
        dispose()
      }
    },
  )

  it('still flushes if hiding the main window fails', async () => {
    windowMock.hide.mockRejectedValueOnce(new Error('hide failed'))
    const dispose = installQuitFlush()
    const closeRequest = closeCurrentWindow()

    await expect(closeRequest.completed).rejects.toThrow('hide failed')
    expect(closeRequest.preventDefault).toHaveBeenCalledOnce()
    expect(flushOpenDocuments).toHaveBeenCalledOnce()
    expect(flushSettings).toHaveBeenCalledOnce()
    expect(flushBackup).toHaveBeenCalledOnce()

    dispose()
  })

  it('waits for backup before confirming app quit', async () => {
    const backup = deferred()
    flushBackup.mockReturnValueOnce(backup.promise)
    const dispose = installQuitFlush()

    try {
      expect(core.quitRequested).not.toBeNull()
      core.quitRequested?.()
      await vi.waitFor(() => expect(flushBackup).toHaveBeenCalledOnce())
      expect(core.confirmQuit).not.toHaveBeenCalled()
      expect(windowMock.hide).not.toHaveBeenCalled()

      backup.resolve()
      await vi.waitFor(() => expect(core.confirmQuit).toHaveBeenCalledOnce())
    } finally {
      backup.resolve()
      dispose()
    }
  })

  it('flushes and hides the macOS main window even when one flush rejects', async () => {
    flushSettings.mockRejectedValueOnce(new Error('settings flush failed'))
    const dispose = installQuitFlush()
    const closeRequest = closeCurrentWindow()

    expect(closeRequest.preventDefault).toHaveBeenCalledOnce()
    await closeRequest.completed
    expect(flushOpenDocuments).toHaveBeenCalledOnce()
    expect(flushSettings).toHaveBeenCalledOnce()
    expect(flushBackup).toHaveBeenCalledOnce()
    expect(windowMock.hide).toHaveBeenCalledOnce()

    dispose()
  })

  it('allows secondary windows to close normally', async () => {
    windowRole.isMainWindow = false
    const dispose = installQuitFlush()
    const closeRequest = closeCurrentWindow()

    expect(closeRequest.preventDefault).not.toHaveBeenCalled()
    await closeRequest.completed
    expect(flushOpenDocuments).toHaveBeenCalledOnce()
    expect(flushBackup).toHaveBeenCalledOnce()
    expect(windowMock.hide).not.toHaveBeenCalled()

    dispose()
  })
})
