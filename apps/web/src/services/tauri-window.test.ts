import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestLoggerService } from '@reflect/core/testing'

const getAllWebviewWindows = vi.hoisted(() => vi.fn())
const getCurrentWindow = vi.hoisted(() => vi.fn())
const emitTo = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@tauri-apps/api/event', () => ({ emitTo }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getAllWebviewWindows,
  getCurrentWebviewWindow: vi.fn(),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow }))

const { createTauriWindowHost } = await import('./tauri-window.ts')

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentWindow.mockReturnValue({ label: 'note-1' })
})

describe('createTauriWindowHost', () => {
  it('reads the label of the current window', () => {
    const host = createTauriWindowHost({ multiWindow: true, logger: createTestLoggerService() })
    expect(host.label).toBe('note-1')
  })

  it('assumes the main window and warns when the label is unavailable', () => {
    getCurrentWindow.mockImplementation(() => {
      throw new Error('no metadata')
    })
    const logger = createTestLoggerService()
    const host = createTauriWindowHost({ multiWindow: true, logger })
    expect(host.label).toBe('main')
    expect(logger.getWarnings()).toEqual([
      {
        message: 'window label unavailable; assuming the main window:',
        cause: new Error('no metadata'),
      },
    ])
  })

  it('finds the focused window and skips one that closes during the check', async () => {
    getAllWebviewWindows.mockResolvedValue([
      { label: 'closing', isFocused: vi.fn(async () => await Promise.reject(new Error('closed'))) },
      { label: 'main', isFocused: vi.fn(() => Promise.resolve(false)) },
      { label: 'note-2', isFocused: vi.fn(() => Promise.resolve(true)) },
    ])
    const host = createTauriWindowHost({ multiWindow: true, logger: createTestLoggerService() })
    await expect(host.focusedWindowLabel()).resolves.toBe('note-2')

    getAllWebviewWindows.mockResolvedValue([
      { label: 'main', isFocused: vi.fn(() => Promise.resolve(false)) },
    ])
    await expect(host.focusedWindowLabel()).resolves.toBeNull()
  })

  it('addresses events to a webview window', async () => {
    const host = createTauriWindowHost({ multiWindow: true, logger: createTestLoggerService() })
    await host.emitTo('note-2', 'menu', 'note.find')
    expect(emitTo).toHaveBeenCalledWith(
      { kind: 'WebviewWindow', label: 'note-2' },
      'menu',
      'note.find',
    )
  })
})
