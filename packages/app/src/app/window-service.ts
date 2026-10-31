import type { MaybePromise } from '@reflect/utils'
import {
  errorMessage,
  INDEX_WRITTEN_EVENT,
  listenNow,
  windowBootstrapSchema,
  type IpcBridgeService,
  type LoggerService,
  type Unlisten,
  type WindowBootstrap,
} from '@reflect/core'
import { z } from 'zod'

/**
 * The label of the window the app opens at launch.
 */
export const MAIN_WINDOW_LABEL = 'main'

/**
 * The shell's `emit_to` request that a note window re-navigate to a `reflect://` link.
 */
export const WINDOW_NAVIGATE_EVENT = 'window:navigate'

/**
 * The event passed to an {@link WindowService.onCloseRequested} handler.
 */
export interface CloseRequestedEvent {
  /**
   * Keep the window open. Call it before the handler's first `await`.
   */
  preventDefault(): void
}

export type CloseRequestedHandler = (event: CloseRequestedEvent) => MaybePromise<void>

/**
 * The native window operations behind a {@link WindowService}.
 */
export interface WindowHost {
  /**
   * This webview's window label.
   */
  readonly label: string
  /**
   * True when the host can open secondary note windows.
   */
  readonly multiWindow: boolean
  setTitle(title: string): MaybePromise<void>
  /**
   * The label of the focused webview window, or `null` when none has focus.
   */
  focusedWindowLabel(): MaybePromise<string | null>
  emitTo(label: string, event: string, payload: unknown): MaybePromise<void>
  /**
   * Listen for events addressed to this window.
   */
  listen(event: string, handler: (payload: unknown) => void): MaybePromise<Unlisten>
  onCloseRequested(handler: CloseRequestedHandler): MaybePromise<Unlisten>
  hide(): MaybePromise<void>
}

/**
 * Facts about this webview's window and the actions that span windows.
 */
export interface WindowService {
  readonly label: string
  isMainWindow(): boolean
  /**
   * Set the OS window title.
   */
  setTitle(title: string): MaybePromise<void>
  /**
   * Open or focus a note window on a `reflect://` link. Concurrent calls for
   * one link share a request. False when the host has no secondary windows
   * or the command fails.
   */
  openNoteWindow(deepLink: string): Promise<boolean>
  /**
   * Close every note window and wait for their flushes. Never rejects.
   */
  closeSecondaryWindows(): MaybePromise<void>
  /**
   * Adopt the main window's open graph and index sessions in a note window.
   */
  bootstrap(): MaybePromise<WindowBootstrap>
  /**
   * Listen for shell requests to re-navigate this window.
   */
  subscribeNavigate(listener: (url: string) => void): Unlisten
  /**
   * Listen for committed index writes.
   */
  subscribeIndexWritten(listener: () => void): Unlisten
  /**
   * Listen for an event that another window sent here with {@link emitTo}.
   */
  subscribeWindowEvent(event: string, listener: (payload: unknown) => void): Unlisten
  focusedWindowLabel(): MaybePromise<string | null>
  emitTo(label: string, event: string, payload: unknown): MaybePromise<void>
  onCloseRequested(handler: CloseRequestedHandler): Unlisten
  hide(): MaybePromise<void>
  /**
   * Open or close the native web inspector of this window.
   */
  toggleDevtools(): MaybePromise<void>
}

export interface WindowServiceDeps {
  readonly ipc: IpcBridgeService
  readonly host: WindowHost
  readonly logger: LoggerService
}

class WindowServiceImpl implements WindowService {
  readonly #deps: WindowServiceDeps
  readonly #pendingOpens = new Map<string, Promise<boolean>>()

  readonly label: string

  constructor(deps: WindowServiceDeps) {
    this.#deps = deps
    this.label = deps.host.label
  }

  isMainWindow(): boolean {
    return this.#deps.host.label === MAIN_WINDOW_LABEL
  }

  async setTitle(title: string): Promise<void> {
    try {
      await this.#deps.host.setTitle(title)
    } catch (cause: unknown) {
      this.#deps.logger.error('setting the window title failed:', errorMessage(cause))
    }
  }

  async openNoteWindow(deepLink: string): Promise<boolean> {
    if (!this.#deps.host.multiWindow) {
      return false
    }
    const pending = this.#pendingOpens.get(deepLink)
    if (pending !== undefined) {
      return await pending
    }
    const opening = this.#open(deepLink)
    this.#pendingOpens.set(deepLink, opening)
    void opening.finally(() => {
      if (this.#pendingOpens.get(deepLink) === opening) {
        this.#pendingOpens.delete(deepLink)
      }
    })
    return await opening
  }

  async closeSecondaryWindows(): Promise<void> {
    const { ipc, host, logger } = this.#deps
    if (!host.multiWindow) {
      return
    }
    try {
      await ipc.call('close_note_windows', {}, z.null())
    } catch (cause) {
      logger.error('closing note windows failed:', errorMessage(cause))
    }
  }

  bootstrap(): Promise<WindowBootstrap> {
    return this.#deps.ipc.call('window_bootstrap', {}, windowBootstrapSchema)
  }

  subscribeNavigate(listener: (url: string) => void): Unlisten {
    const { logger } = this.#deps
    return this.#listenIpc(WINDOW_NAVIGATE_EVENT, (payload) => {
      const parsed = z.string().safeParse(payload)
      if (parsed.success) {
        listener(parsed.data)
      } else {
        logger.error('invalid window:navigate payload:', parsed.error)
      }
    })
  }

  subscribeIndexWritten(listener: () => void): Unlisten {
    return this.#listenIpc(INDEX_WRITTEN_EVENT, () => {
      listener()
    })
  }

  subscribeWindowEvent(event: string, listener: (payload: unknown) => void): Unlisten {
    return this.#track(() => this.#deps.host.listen(event, listener), event)
  }

  focusedWindowLabel(): MaybePromise<string | null> {
    return this.#deps.host.focusedWindowLabel()
  }

  emitTo(label: string, event: string, payload: unknown): MaybePromise<void> {
    return this.#deps.host.emitTo(label, event, payload)
  }

  onCloseRequested(handler: CloseRequestedHandler): Unlisten {
    return this.#track(() => this.#deps.host.onCloseRequested(handler), 'close-requested')
  }

  hide(): MaybePromise<void> {
    return this.#deps.host.hide()
  }

  async toggleDevtools(): Promise<void> {
    await this.#deps.ipc.call('toggle_devtools', {}, z.null())
  }

  #track(register: () => MaybePromise<Unlisten>, what: string): Unlisten {
    return listenNow(register, (cause) => {
      this.#deps.logger.error(`${what} listener failed:`, cause)
    })
  }

  #listenIpc(event: string, handler: (payload: unknown) => void): Unlisten {
    return this.#track(() => this.#deps.ipc.listen(event, handler), event)
  }

  async #open(deepLink: string): Promise<boolean> {
    const { ipc, logger } = this.#deps
    try {
      await ipc.call('open_note_window', { deepLink }, z.null())
      return true
    } catch (cause) {
      logger.error('open in new window failed:', errorMessage(cause))
      return false
    }
  }
}

export function createWindowService(deps: WindowServiceDeps): WindowService {
  return new WindowServiceImpl(deps)
}

class SingleWindowHostImpl implements WindowHost {
  readonly label = MAIN_WINDOW_LABEL
  readonly multiWindow = false

  setTitle(_title: string): void {}

  focusedWindowLabel(): string | null {
    return MAIN_WINDOW_LABEL
  }

  emitTo(_label: string, _event: string, _payload: unknown): void {}

  listen(_event: string, _handler: (payload: unknown) => void): Unlisten {
    return () => {}
  }

  onCloseRequested(_handler: CloseRequestedHandler): Unlisten {
    return () => {}
  }

  hide(): void {}
}

/**
 * The host of a single webview with no native windows: the main window.
 */
export function createSingleWindowHost(): WindowHost {
  return new SingleWindowHostImpl()
}
