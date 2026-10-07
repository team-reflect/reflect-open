import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface CloseRequestedEventForTest {
  preventDefault: () => void
}

type CloseRequestedHandler = (event: CloseRequestedEventForTest) => Promise<void>

const windowMock = vi.hoisted(() => ({
  closeRequested: null as CloseRequestedHandler | null,
  hide: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  unlisten: vi.fn(),
}))
const windowRole = vi.hoisted(() => ({ isMainWindow: true }))
const core = vi.hoisted(() => ({
  confirmQuit: vi.fn(async () => {}),
  cancelQuit: vi.fn(async () => {}),
  quitRequested: null as (() => void) | null,
  unlisten: vi.fn(),
}))
const flushOpenDocuments = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []))
const ask = vi.hoisted(() => vi.fn(async (_message: string) => true))
const flushSettings = vi.hoisted(() => vi.fn(async () => {}))
const flushBackup = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    hide: windowMock.hide,
    destroy: windowMock.destroy,
    onCloseRequested: async (handler: CloseRequestedHandler) => {
      windowMock.closeRequested = handler
      return windowMock.unlisten
    },
  }),
}))

vi.mock('@reflect/core', () => ({
  confirmQuit: core.confirmQuit,
  cancelQuit: core.cancelQuit,
  subscribeQuitRequested: async (handler: () => void) => {
    core.quitRequested = handler
    return core.unlisten
  },
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ ask }))
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

function closeCurrentWindow(): CloseRequestForTest {
  const preventDefault = vi.fn()
  const closeRequested = windowMock.closeRequested
  expect(closeRequested).not.toBeNull()
  const completed = closeRequested?.({ preventDefault }) ?? Promise.resolve()
  return { completed, preventDefault }
}

describe('installQuitFlush', () => {
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

  it('asks before quitting with edits that could not be archived, and stays on cancel', async () => {
    flushOpenDocuments.mockResolvedValueOnce(['daily/2026-10-07.md'])
    ask.mockResolvedValueOnce(false)
    const dispose = installQuitFlush()
    expect(core.quitRequested).not.toBeNull()
    core.quitRequested?.()
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce())
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining('daily/2026-10-07.md'),
      expect.anything(),
    )
    await vi.waitFor(() => expect(core.cancelQuit).toHaveBeenCalledOnce())
    expect(core.confirmQuit).not.toHaveBeenCalled()

    dispose()
  })

  it('quits when the user accepts losing unarchived edits', async () => {
    flushOpenDocuments.mockResolvedValueOnce(['daily/2026-10-07.md'])
    ask.mockResolvedValueOnce(true)
    const dispose = installQuitFlush()
    core.quitRequested?.()
    await vi.waitFor(() => expect(core.confirmQuit).toHaveBeenCalledOnce())

    dispose()
  })

  it('keeps the main window open when hiding would discard unarchived edits', async () => {
    flushOpenDocuments.mockResolvedValueOnce(['notes/a.md'])
    ask.mockResolvedValueOnce(false)
    const dispose = installQuitFlush()
    const closeRequest = closeCurrentWindow()
    await closeRequest.completed
    expect(ask).toHaveBeenCalledOnce()
    expect(windowMock.hide).not.toHaveBeenCalled()

    dispose()
  })

  it('secondary windows flush, then destroy instead of hiding', async () => {
    windowRole.isMainWindow = false
    const dispose = installQuitFlush()
    const closeRequest = closeCurrentWindow()

    expect(closeRequest.preventDefault).toHaveBeenCalledOnce()
    await closeRequest.completed
    expect(flushOpenDocuments).toHaveBeenCalledOnce()
    expect(flushBackup).toHaveBeenCalledOnce()
    expect(windowMock.hide).not.toHaveBeenCalled()
    expect(windowMock.destroy).toHaveBeenCalledOnce()

    dispose()
  })

  it('a secondary window stays open when closing would discard unarchived edits', async () => {
    windowRole.isMainWindow = false
    flushOpenDocuments.mockResolvedValueOnce(['notes/a.md'])
    ask.mockResolvedValueOnce(false)
    const dispose = installQuitFlush()
    const closeRequest = closeCurrentWindow()
    await closeRequest.completed
    expect(windowMock.destroy).not.toHaveBeenCalled()

    dispose()
  })
})
