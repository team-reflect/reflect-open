import type { ActivityPort, BackgroundTaskToken } from '../ports/activity-port.ts'
import type { Unlisten } from '../unlisten.ts'

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

export interface TestActivityPort extends ActivityPort {
  emitResume(): void
  emitWake(): void
  emitFocus(): void
  emitVisible(): void
  emitHidden(): void
  setHidden(hidden: boolean): void
  /**
   * Every background task begun, in order.
   */
  backgroundTasks(): readonly { token: BackgroundTaskToken; ended: boolean }[]
}

export interface TestActivityPortOptions {
  hidden?: boolean
  backgroundTasks?: boolean
}

class TestActivityPortImpl implements TestActivityPort {
  readonly #options: TestActivityPortOptions | undefined
  readonly #resume = new Listeners()
  readonly #wake = new Listeners()
  readonly #focus = new Listeners()
  readonly #visible = new Listeners()
  readonly #hiddenListeners = new Listeners()
  readonly #tasks: { token: BackgroundTaskToken; ended: boolean }[] = []
  #isHidden: boolean

  constructor(options: TestActivityPortOptions | undefined) {
    this.#options = options
    this.#isHidden = options?.hidden ?? false
  }

  subscribeResume(listener: () => void): Unlisten {
    return this.#resume.add(listener)
  }

  subscribeWake(listener: () => void): Unlisten {
    return this.#wake.add(listener)
  }

  subscribeFocus(listener: () => void): Unlisten {
    return this.#focus.add(listener)
  }

  subscribeVisible(listener: () => void): Unlisten {
    return this.#visible.add(listener)
  }

  subscribeHidden(listener: () => void): Unlisten {
    return this.#hiddenListeners.add(listener)
  }

  isHidden(): boolean {
    return this.#isHidden
  }

  beginBackgroundTask(): BackgroundTaskToken | null {
    if (!(this.#options?.backgroundTasks ?? false)) {
      return null
    }
    const token = `background-task-${this.#tasks.length + 1}`
    this.#tasks.push({ token, ended: false })
    return token
  }

  endBackgroundTask(token: BackgroundTaskToken): Promise<void> {
    const task = this.#tasks.find((entry) => entry.token === token)
    if (task !== undefined) {
      task.ended = true
    }
    return Promise.resolve()
  }

  emitResume(): void {
    this.#resume.emit()
  }

  emitWake(): void {
    this.#wake.emit()
  }

  emitFocus(): void {
    this.#focus.emit()
  }

  emitVisible(): void {
    this.#isHidden = false
    this.#visible.emit()
  }

  emitHidden(): void {
    this.#isHidden = true
    this.#hiddenListeners.emit()
  }

  setHidden(hidden: boolean): void {
    this.#isHidden = hidden
  }

  backgroundTasks(): readonly { token: BackgroundTaskToken; ended: boolean }[] {
    return this.#tasks.map((task) => ({ ...task }))
  }
}

/**
 * An {@link ActivityPort} driven by its `emit*` methods. `emitVisible` and
 * `emitHidden` also update {@link ActivityPort.isHidden}. Without
 * `backgroundTasks`, `beginBackgroundTask` resolves `null`.
 */
export function createTestActivityPort(options?: TestActivityPortOptions): TestActivityPort {
  return new TestActivityPortImpl(options)
}
