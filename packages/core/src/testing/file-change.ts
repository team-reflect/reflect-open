import type {
  FileChange,
  FileChangeBatch,
  FileChangeService,
} from '../indexing/file-change-service.ts'
import type { Unlisten } from '../unlisten.ts'

export interface TestFileChangeServiceOptions {
  /**
   * Echo own writes onto the change stream. Defaults to `false`.
   */
  echoOwnWrites?: boolean
}

export interface TestFileChangeService extends FileChangeService {
  /**
   * Notify every `subscribeReconcile` listener.
   */
  emitReconcile(): void
  /**
   * Every batch delivered on the change stream, in order.
   */
  batches(): readonly FileChangeBatch[]
  /**
   * Every path list passed to `reportOwnWrite`, in order.
   */
  ownWrites(): readonly (readonly string[])[]
  /**
   * Whether the watcher was started and not stopped since.
   */
  watcherRunning(): boolean
  /**
   * How many listeners of each kind are attached.
   */
  listenerCount(): { changes: number; reconcile: number }
}

function attach<Args extends unknown[]>(
  listeners: Set<(...args: Args) => void>,
  listener: (...args: Args) => void,
): () => void {
  // Wrapped for identity, so one function added twice detaches independently.
  const deliver = (...args: Args): void => {
    listener(...args)
  }
  listeners.add(deliver)
  return () => {
    listeners.delete(deliver)
  }
}

class TestFileChangeServiceImpl implements TestFileChangeService {
  readonly #echoOwnWrites: boolean
  readonly #changeListeners = new Set<(batch: FileChangeBatch) => void>()
  readonly #reconcileListeners = new Set<() => void>()
  readonly #delivered: FileChangeBatch[] = []
  readonly #reported: (readonly string[])[] = []
  #running = false

  constructor(options: TestFileChangeServiceOptions | undefined) {
    this.#echoOwnWrites = options?.echoOwnWrites ?? false
  }

  subscribe(listener: (batch: FileChangeBatch) => void): Unlisten {
    return attach(this.#changeListeners, listener)
  }

  subscribeReconcile(listener: () => void): Unlisten {
    return attach(this.#reconcileListeners, listener)
  }

  emit(batch: FileChangeBatch): void {
    this.#delivered.push(batch)
    for (const listener of this.#changeListeners) {
      listener(batch)
    }
  }

  reportOwnWrite(changes: readonly FileChange[]): void {
    this.#reported.push(changes.map((change) => change.path))
    if (this.#echoOwnWrites) {
      this.emit({ changes: [...changes], source: 'own-write' })
    }
  }

  startWatcher(): void {
    this.#running = true
  }

  stopWatcher(): void {
    this.#running = false
  }

  emitReconcile(): void {
    for (const listener of this.#reconcileListeners) {
      listener()
    }
  }

  batches(): readonly FileChangeBatch[] {
    return [...this.#delivered]
  }

  ownWrites(): readonly (readonly string[])[] {
    return [...this.#reported]
  }

  watcherRunning(): boolean {
    return this.#running
  }

  listenerCount(): { changes: number; reconcile: number } {
    return {
      changes: this.#changeListeners.size,
      reconcile: this.#reconcileListeners.size,
    }
  }
}

/**
 * An in-memory {@link FileChangeService} with no native watcher behind it.
 */
export function createTestFileChangeService(
  options?: TestFileChangeServiceOptions,
): TestFileChangeService {
  return new TestFileChangeServiceImpl(options)
}
