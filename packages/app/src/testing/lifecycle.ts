import type { MaybePromise } from '@reflect/utils'
import type { BackgroundTaskToken, Unlisten } from '@reflect/core'
import {
  createTestActivityPort,
  type TestActivityPort,
  type TestActivityPortOptions,
} from '@reflect/core/testing'
import type { AppLifecycleService } from '../app/lifecycle-service.ts'

export interface TestLifecycleService extends AppLifecycleService, TestActivityPort {
  emitPageHide(): void
  emitBeforeUnload(): void
  emitQuitRequested(): void
  confirmQuitCalls(): number
}

export interface TestLifecycleServiceOptions extends TestActivityPortOptions {
  /**
   * The activity signals to share, e.g. the `activity` of test core services.
   * Defaults to a new test activity port built from the other options.
   */
  activity?: TestActivityPort
}

class Listeners {
  readonly #listeners = new Set<() => void>()

  add(listener: () => void): Unlisten {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  emit(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

class TestLifecycleServiceImpl implements TestLifecycleService {
  readonly #activity: TestActivityPort
  readonly #pageHide = new Listeners()
  readonly #beforeUnload = new Listeners()
  readonly #quitRequested = new Listeners()
  #confirmCalls = 0

  constructor(options: TestLifecycleServiceOptions | undefined) {
    this.#activity = options?.activity ?? createTestActivityPort(options)
  }

  subscribeResume(listener: () => void): Unlisten {
    return this.#activity.subscribeResume(listener)
  }

  subscribeWake(listener: () => void): Unlisten {
    return this.#activity.subscribeWake(listener)
  }

  subscribeFocus(listener: () => void): Unlisten {
    return this.#activity.subscribeFocus(listener)
  }

  subscribeVisible(listener: () => void): Unlisten {
    return this.#activity.subscribeVisible(listener)
  }

  subscribeHidden(listener: () => void): Unlisten {
    return this.#activity.subscribeHidden(listener)
  }

  subscribePageHide(listener: () => void): Unlisten {
    return this.#pageHide.add(listener)
  }

  subscribeBeforeUnload(listener: () => void): Unlisten {
    return this.#beforeUnload.add(listener)
  }

  isHidden(): boolean {
    return this.#activity.isHidden()
  }

  subscribeQuitRequested(listener: () => void): Unlisten {
    return this.#quitRequested.add(listener)
  }

  confirmQuit(): void {
    this.#confirmCalls += 1
  }

  beginBackgroundTask(): MaybePromise<BackgroundTaskToken | null> {
    return this.#activity.beginBackgroundTask()
  }

  endBackgroundTask(token: BackgroundTaskToken): MaybePromise<void> {
    return this.#activity.endBackgroundTask(token)
  }

  emitResume(): void {
    this.#activity.emitResume()
  }

  emitWake(): void {
    this.#activity.emitWake()
  }

  emitFocus(): void {
    this.#activity.emitFocus()
  }

  emitVisible(): void {
    this.#activity.emitVisible()
  }

  emitHidden(): void {
    this.#activity.emitHidden()
  }

  emitPageHide(): void {
    this.#pageHide.emit()
  }

  emitBeforeUnload(): void {
    this.#beforeUnload.emit()
  }

  emitQuitRequested(): void {
    this.#quitRequested.emit()
  }

  setHidden(hidden: boolean): void {
    this.#activity.setHidden(hidden)
  }

  confirmQuitCalls(): number {
    return this.#confirmCalls
  }

  backgroundTasks(): readonly { token: BackgroundTaskToken; ended: boolean }[] {
    return this.#activity.backgroundTasks()
  }
}

/**
 * An {@link AppLifecycleService} driven by its `emit*` methods, over a test
 * activity port. `emitVisible` and `emitHidden` also update
 * {@link AppLifecycleService.isHidden}. Without `backgroundTasks`,
 * `beginBackgroundTask` resolves `null`.
 */
export function createTestLifecycleService(
  options?: TestLifecycleServiceOptions,
): TestLifecycleService {
  return new TestLifecycleServiceImpl(options)
}
