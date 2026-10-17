import type { MaybePromise } from '@reflect/utils'
import type { Unlisten, WindowBootstrap } from '@reflect/core'
import {
  MAIN_WINDOW_LABEL,
  type CloseRequestedHandler,
  type WindowService,
} from '../app/window-service.ts'

type Listener<Args extends unknown[] = []> = (...args: Args) => void

class Listeners<Args extends unknown[] = []> {
  readonly #listeners = new Set<Listener<Args>>()

  add(listener: Listener<Args>): Unlisten {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver: Listener<Args> = (...args) => {
      listener(...args)
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  emit(...args: Args): void {
    for (const listener of this.#listeners) {
      listener(...args)
    }
  }
}

export interface TestWindowService extends WindowService {
  openedNoteWindows(): readonly string[]
  closeSecondaryWindowsCalls(): number
  /**
   * The last title set, or `null`.
   */
  title(): string | null
  emitNavigate(url: string): void
  emitIndexWritten(): void
  /**
   * Deliver an event to {@link WindowService.subscribeWindowEvent} listeners.
   */
  emitWindowEvent(event: string, payload: unknown): void
  emitted(): readonly { label: string; event: string; payload: unknown }[]
  setFocusedWindowLabel(label: string | null): void
  hidden(): boolean
  devtoolsToggles(): number
}

export interface TestWindowServiceOptions {
  label?: string
  bootstrap?: WindowBootstrap
  openNoteWindow?: (deepLink: string) => MaybePromise<boolean>
}

class TestWindowServiceImpl implements TestWindowService {
  readonly #options: TestWindowServiceOptions | undefined
  readonly #opened: string[] = []
  readonly #emittedEvents: { label: string; event: string; payload: unknown }[] = []
  readonly #navigate = new Listeners<[url: string]>()
  readonly #indexWritten = new Listeners()
  readonly #windowEvents = new Map<string, Listeners<[payload: unknown]>>()
  readonly #closeHandlers = new Set<CloseRequestedHandler>()
  #closeCalls = 0
  #currentTitle: string | null = null
  #focused: string | null
  #isHidden = false
  #toggles = 0

  readonly label: string

  constructor(options: TestWindowServiceOptions | undefined) {
    this.#options = options
    this.label = options?.label ?? MAIN_WINDOW_LABEL
    this.#focused = this.label
  }

  isMainWindow(): boolean {
    return this.label === MAIN_WINDOW_LABEL
  }

  setTitle(title: string): void {
    this.#currentTitle = title
  }

  async openNoteWindow(deepLink: string): Promise<boolean> {
    this.#opened.push(deepLink)
    return (await this.#options?.openNoteWindow?.(deepLink)) ?? true
  }

  async closeSecondaryWindows(): Promise<void> {
    this.#closeCalls += 1
  }

  async bootstrap(): Promise<WindowBootstrap> {
    if (this.#options?.bootstrap === undefined) {
      throw new Error('test window: no bootstrap configured')
    }
    return this.#options.bootstrap
  }

  subscribeNavigate(listener: (url: string) => void): Unlisten {
    return this.#navigate.add(listener)
  }

  subscribeIndexWritten(listener: () => void): Unlisten {
    return this.#indexWritten.add(listener)
  }

  subscribeWindowEvent(event: string, listener: (payload: unknown) => void): Unlisten {
    let listeners = this.#windowEvents.get(event)
    if (listeners === undefined) {
      listeners = new Listeners<[payload: unknown]>()
      this.#windowEvents.set(event, listeners)
    }
    return listeners.add(listener)
  }

  async focusedWindowLabel(): Promise<string | null> {
    return this.#focused
  }

  async emitTo(target: string, event: string, payload: unknown): Promise<void> {
    this.#emittedEvents.push({ label: target, event, payload })
  }

  onCloseRequested(handler: CloseRequestedHandler): Unlisten {
    this.#closeHandlers.add(handler)
    return () => {
      this.#closeHandlers.delete(handler)
    }
  }

  async hide(): Promise<void> {
    this.#isHidden = true
  }

  async toggleDevtools(): Promise<void> {
    this.#toggles += 1
  }

  openedNoteWindows(): readonly string[] {
    return [...this.#opened]
  }

  closeSecondaryWindowsCalls(): number {
    return this.#closeCalls
  }

  title(): string | null {
    return this.#currentTitle
  }

  emitNavigate(url: string): void {
    this.#navigate.emit(url)
  }

  emitIndexWritten(): void {
    this.#indexWritten.emit()
  }

  emitWindowEvent(event: string, payload: unknown): void {
    this.#windowEvents.get(event)?.emit(payload)
  }

  emitted(): readonly { label: string; event: string; payload: unknown }[] {
    return [...this.#emittedEvents]
  }

  setFocusedWindowLabel(label: string | null): void {
    this.#focused = label
  }

  hidden(): boolean {
    return this.#isHidden
  }

  devtoolsToggles(): number {
    return this.#toggles
  }
}

/**
 * An in-memory {@link WindowService}. `openNoteWindow` answers `true` unless
 * `options.openNoteWindow` says otherwise.
 */
export function createTestWindowService(options?: TestWindowServiceOptions): TestWindowService {
  return new TestWindowServiceImpl(options)
}
