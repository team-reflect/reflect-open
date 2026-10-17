import { describe, expect, it, vi } from 'vitest'
import type { Unlisten } from '@reflect/core'
import {
  createTestIpcBridgeService,
  createTestLoggerService,
  type TestIpcBridgeService,
} from '@reflect/core/testing'
import {
  createSingleWindowHost,
  createWindowService,
  type CloseRequestedHandler,
  type WindowHost,
} from './window-service.ts'

const BOOT = {
  graph: { root: '/g', name: 'g', generation: 3 },
  indexGeneration: 5,
  initialDeepLink: 'reflect://note/notes%2Fa.md',
}

function setup(options?: { host?: Partial<WindowHost>; ipc?: TestIpcBridgeService }) {
  const ipc = options?.ipc ?? createTestIpcBridgeService()
  const logger = createTestLoggerService()
  const host: WindowHost = Object.assign(
    createSingleWindowHost(),
    { multiWindow: true },
    options?.host,
  )
  const window = createWindowService({ ipc, host, logger })
  return { window, ipc, logger }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve()
  }
}

describe('createWindowService', () => {
  it('reports the main window by label', () => {
    expect(setup().window.isMainWindow()).toBe(true)
    const note = setup({ host: { label: 'note-1' } }).window
    expect(note.label).toBe('note-1')
    expect(note.isMainWindow()).toBe(false)
  })

  it('logs a failed title change', async () => {
    const setTitle = vi.fn(async () => {
      throw new Error('gone')
    })
    const { window, logger } = setup({ host: { setTitle } })
    await window.setTitle('Note A')
    expect(setTitle).toHaveBeenCalledWith('Note A')
    expect(logger.getErrors()).toEqual([
      { message: 'setting the window title failed:', cause: 'gone' },
    ])
  })

  it('shares one open_note_window request between concurrent opens of one link', async () => {
    const pending = Promise.withResolvers<null>()
    const { window, ipc } = setup()
    ipc.onCommand('open_note_window', () => pending.promise)

    const first = window.openNoteWindow('reflect://note/a')
    const second = window.openNoteWindow('reflect://note/a')
    pending.resolve(null)

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(ipc.calls()).toEqual([
      { command: 'open_note_window', args: { deepLink: 'reflect://note/a' } },
    ])
    await expect(window.openNoteWindow('reflect://note/a')).resolves.toBe(true)
    expect(ipc.calls()).toHaveLength(2)
  })

  it('answers false and logs when the window cannot open', async () => {
    const { window, ipc, logger } = setup()
    ipc.onCommand('open_note_window', () => {
      throw new Error('no window for you')
    })

    await expect(window.openNoteWindow('reflect://note/a')).resolves.toBe(false)
    expect(logger.getErrors()).toEqual([
      { message: 'open in new window failed:', cause: 'no window for you' },
    ])
  })

  it('opens and closes nothing on a single-window host', async () => {
    const { window, ipc } = setup({ host: { multiWindow: false } })

    await expect(window.openNoteWindow('reflect://note/a')).resolves.toBe(false)
    await window.closeSecondaryWindows()
    expect(ipc.calls()).toEqual([])
  })

  it('closes note windows and logs a failure instead of rejecting', async () => {
    const { window, ipc, logger } = setup()
    ipc.onCommand('close_note_windows', () => null)
    await window.closeSecondaryWindows()
    expect(ipc.calls().map((call) => call.command)).toEqual(['close_note_windows'])

    ipc.onCommand('close_note_windows', () => {
      throw new Error('wedged')
    })
    await expect(window.closeSecondaryWindows()).resolves.toBeUndefined()
    expect(logger.getErrors()).toEqual([
      { message: 'closing note windows failed:', cause: 'wedged' },
    ])
  })

  it('bootstraps a note window and toggles devtools over IPC', async () => {
    const { window, ipc } = setup()
    ipc.onCommand('window_bootstrap', () => BOOT)
    ipc.onCommand('toggle_devtools', () => null)

    await expect(window.bootstrap()).resolves.toEqual(BOOT)
    await window.toggleDevtools()
    expect(ipc.calls().map((call) => call.command)).toEqual(['window_bootstrap', 'toggle_devtools'])
  })

  it('delivers navigate requests and drops malformed payloads', async () => {
    const { window, ipc, logger } = setup()
    const navigate = vi.fn()
    const unlisten = window.subscribeNavigate(navigate)
    await settle()

    ipc.emit('window:navigate', 'reflect://note/a')
    ipc.emit('window:navigate', 42)
    unlisten()
    ipc.emit('window:navigate', 'reflect://note/b')

    expect(navigate.mock.calls).toEqual([['reflect://note/a']])
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'invalid window:navigate payload:',
    ])
  })

  it('delivers index writes to a listener registered before the bridge answers', async () => {
    const listen = Promise.withResolvers<void>()
    const ipc = createTestIpcBridgeService()
    const transport = ipc.transport
    const transportListen = transport.listen.bind(transport)
    ipc.transport.listen = async (event, handler) => {
      await listen.promise
      return await transportListen(event, handler)
    }
    const { window } = setup({ ipc })
    const written = vi.fn()

    window.subscribeIndexWritten(written)
    listen.resolve()
    await settle()
    ipc.emit('index:written', null)

    expect(written).toHaveBeenCalledOnce()
  })

  it('logs a failed event registration', async () => {
    const ipc = createTestIpcBridgeService()
    ipc.transport.listen = async () => {
      throw new Error('denied')
    }
    const { window, logger } = setup({ ipc })

    window.subscribeIndexWritten(() => {})
    await settle()

    expect(logger.getErrors()).toEqual([
      { message: 'index:written listener failed:', cause: new Error('denied') },
    ])
  })

  it('routes cross-window events and window actions through the host', async () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    const removed = vi.fn()
    let closeHandler: CloseRequestedHandler | null = null
    const emitTo = vi.fn(async () => {})
    const hide = vi.fn(async () => {})
    const { window } = setup({
      host: {
        focusedWindowLabel: () => 'note-2',
        emitTo,
        hide,
        listen: (event, handler): Unlisten => {
          handlers.set(event, handler)
          return removed
        },
        onCloseRequested: (handler) => {
          closeHandler = handler
          return removed
        },
      },
    })
    const received = vi.fn()

    const unlistenEvent = window.subscribeWindowEvent('menu', received)
    const unlistenClose = window.onCloseRequested(() => {})
    await settle()
    handlers.get('menu')?.('note.find')
    await window.emitTo('note-2', 'menu', 'note.find')
    await window.hide()
    unlistenEvent()
    unlistenClose()

    expect(await window.focusedWindowLabel()).toBe('note-2')
    expect(received).toHaveBeenCalledWith('note.find')
    expect(emitTo).toHaveBeenCalledWith('note-2', 'menu', 'note.find')
    expect(hide).toHaveBeenCalledOnce()
    expect(closeHandler).not.toBeNull()
    expect(removed).toHaveBeenCalledTimes(2)
  })
})
