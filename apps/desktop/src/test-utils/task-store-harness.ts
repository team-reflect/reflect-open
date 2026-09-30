import {
  TaskStore,
  indexedTaskKey,
  inlineMarkdownToDisplayText,
  projectTasks,
  type Task,
  type TaskStoreIO,
} from '@reflect/core'

export interface NoteMeta {
  noteTitle: string
  dailyDate: string | null
  isPinned: boolean
  pinnedOrder: number | null
  updatedAt?: number
}

/**
 * The real `TaskStore` over in-memory Markdown notes. `indexed` plays the
 * SQLite index: it projects the tasks of every note in `notes`, so a screen
 * test can serve `getOpenTasks` / `getCompletedTasks` from it and watch the
 * Markdown the store writes.
 */
export interface TaskStoreHarness {
  store: TaskStore
  /** The in-memory notes, path -> Markdown source. Tests seed and inspect this. */
  notes: Map<string, string>
  /** Per-note metadata the index rows carry (title, daily date, pin). */
  meta: Map<string, NoteMeta>
  /** What `getOpenTasks()` / `getCompletedTasks()` return for the current notes. */
  indexed(checked: boolean): Task[]
  /** Spy on writes: (path, source) per successful write. */
  writes: Array<{ path: string; source: string }>
  /** Make the next write reject with this error (once). */
  failNextWrite(error: Error): void
  /** Called after each successful write; the test setup passes a function that refetches the mocked queries. */
  onWritten?: (() => Promise<void>) | undefined
  /** The store's IO, for tests that spy on `failure` or gate `write`. */
  io: TaskStoreIO
}

const DAILY_PATH_RE = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/u

function defaultMeta(path: string): NoteMeta {
  const dailyDate = DAILY_PATH_RE.exec(path)?.[1] ?? null
  const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/u, '')
  return { noteTitle: dailyDate ?? stem, dailyDate, isPinned: false, pinnedOrder: null }
}

export function createTaskStoreHarness(options?: {
  onWritten?: () => Promise<void>
}): TaskStoreHarness {
  const notes = new Map<string, string>()
  const meta = new Map<string, NoteMeta>()
  const writes: Array<{ path: string; source: string }> = []
  const failures: Error[] = []
  const io: TaskStoreIO = {
    read: async (path) => notes.get(path) ?? null,
    write: async (path, before, source) => {
      const failure = failures.shift()
      if (failure) throw failure
      if ((notes.get(path) ?? null) !== before) throw new Error('This note changed while saving.')
      notes.set(path, source)
      writes.push({ path, source })
      await harness.onWritten?.()
    },
    failure: () => {},
    saved: () => {},
  }
  const harness: TaskStoreHarness = {
    store: new TaskStore(io),
    notes,
    meta,
    writes,
    io,
    onWritten: options?.onWritten,
    indexed(checked) {
      return [...notes.keys()].sort().flatMap((path) => {
        const { updatedAt = 0, ...note } = meta.get(path) ?? defaultMeta(path)
        return projectTasks(notes.get(path) ?? '')
          .filter((task) => task.checked === checked)
          .map((task) => ({
            ...note,
            ...task,
            key: indexedTaskKey(path, task.astPath),
            notePath: path,
            displayText: inlineMarkdownToDisplayText(task.text),
            updatedAt,
          }))
      })
    },
    failNextWrite(error) {
      failures.push(error)
    },
  }
  return harness
}
