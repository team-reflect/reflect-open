import { beforeEach, describe, expect, it, vi } from 'vitest'

interface TauriEventForTest {
  readonly payload: unknown
}

type TauriEventHandlerForTest = (event: TauriEventForTest) => void

interface ListenOptionsForTest {
  readonly target?: string
}

const unlisten = vi.hoisted(() => vi.fn())
const listen = vi.hoisted(() =>
  vi.fn(
    async (_event: string, _handler: TauriEventHandlerForTest, _options?: ListenOptionsForTest) =>
      unlisten,
  ),
)
const currentLabel = vi.hoisted(() => ({ value: 'note-1' }))

vi.mock('@tauri-apps/api/core', () => ({
  addPluginListener: vi.fn(),
  invoke: vi.fn(),
  isTauri: () => true,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: currentLabel.value }),
}))

const { tauriBridge } = await import('./tauri-bridge')

beforeEach(() => {
  listen.mockClear()
  unlisten.mockClear()
  currentLabel.value = 'note-1'
})

describe('tauriBridge.listen', () => {
  // Tauri's default `Any` target also receives `emit_to` events addressed to
  // other windows, which made `window:navigate` re-navigate every note window.
  it('targets the current window so emit_to events for other windows are not delivered', async () => {
    await tauriBridge.listen('window:navigate', () => {})

    expect(listen).toHaveBeenCalledTimes(1)
    expect(listen.mock.calls[0]?.[0]).toBe('window:navigate')
    expect(listen.mock.calls[0]?.[2]).toEqual({ target: 'note-1' })
  })

  it('reads the window label per subscription rather than at import time', async () => {
    currentLabel.value = 'main'
    await tauriBridge.listen('index:changed', () => {})

    expect(listen.mock.calls[0]?.[2]).toEqual({ target: 'main' })
  })

  it('forwards only the event payload to the handler', async () => {
    const handler = vi.fn()
    await tauriBridge.listen('window:navigate', handler)

    listen.mock.calls[0]?.[1]({ payload: 'reflect://note/alpha' })

    expect(handler).toHaveBeenCalledWith('reflect://note/alpha')
  })

  it('unlistens through the returned teardown', async () => {
    const teardown = await tauriBridge.listen('window:navigate', () => {})

    teardown()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
