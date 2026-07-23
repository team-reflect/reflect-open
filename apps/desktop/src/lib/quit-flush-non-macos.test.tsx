import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A browser-mode module mock materializes value exports once, so
// `isMacosDesktop` cannot flip per test. The non-macOS behavior lives here
// with the flag statically false; quit-flush.test.ts covers macOS.

interface CloseRequestedEventForTest {
  preventDefault: () => void
}

type CloseRequestedHandler = (event: CloseRequestedEventForTest) => Promise<void>

const windowMock = vi.hoisted(() => ({
  closeRequested: null as CloseRequestedHandler | null,
  hide: vi.fn(async () => {}),
  unlisten: vi.fn(),
}))
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
vi.mock('@/lib/platform', () => ({ isMacosDesktop: false }))
vi.mock('@/lib/windows/window-role', () => ({
  isMainWindow: () => true,
}))

const { installQuitFlush } = await import('./quit-flush')

beforeEach(() => {
  windowMock.closeRequested = null
  core.quitRequested = null
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('installQuitFlush outside macOS', () => {
  it('allows the main window to close normally', async () => {
    const dispose = installQuitFlush()
    const preventDefault = vi.fn()
    const closeRequested = windowMock.closeRequested
    expect(closeRequested).not.toBeNull()
    const completed = closeRequested?.({ preventDefault }) ?? Promise.resolve()

    expect(preventDefault).not.toHaveBeenCalled()
    await completed
    expect(windowMock.hide).not.toHaveBeenCalled()

    dispose()
  })
})
