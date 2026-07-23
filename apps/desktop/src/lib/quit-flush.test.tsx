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
  hasBridge: () => true,
  subscribeQuitRequested: async (handler: () => void) => {
    core.quitRequested = handler
    return core.unlisten
  },
}))

vi.mock('@/editor/open-documents', () => ({ flushOpenDocuments }))
vi.mock('@/lib/backup-flush', () => ({ flushBackup }))
vi.mock('@/lib/settings-flush', () => ({ flushSettings }))
vi.mock('@/lib/platform', () => ({ isMacosDesktop: true }))
vi.mock('@/lib/windows/window-role', () => ({
  isMainWindow: () => windowRole.isMainWindow,
}))

const { installQuitFlush } = await import('./quit-flush')

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
