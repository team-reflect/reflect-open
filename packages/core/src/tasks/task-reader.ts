import type { IndexCommitted, TaskRead } from '@reflect/types'
import { z } from 'zod'
import type { DatabaseService } from '../indexing/database-service.ts'
import { INDEX_COMMITTED_EVENT, listenNow, type IpcBridgeService } from '../ipc/ipc-service.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { Unlisten } from '../unlisten.ts'

/**
 * The wait before the first retry of a failed read. Each further failure doubles it.
 */
const READ_RETRY_MIN_MS = 250

/**
 * The longest wait between retries of a failed read.
 */
const READ_RETRY_MAX_MS = 30_000

const indexCommittedSchema = z.object({
  seq: z.number(),
  paths: z.array(z.string()).nullable(),
})

export interface TaskReaderDeps {
  readonly database: DatabaseService
  readonly ipc: IpcBridgeService
  readonly clock: ClockService
  readonly logger: LoggerService
}

/**
 * Reads the tasks of the index, grouped by note, with the index seq they were
 * read at. The tasks of a note come in no fixed order. A failed read is
 * logged and tried again after a growing wait, until it succeeds or `signal`
 * aborts; an aborted read resolves `null`.
 */
export interface TaskReader {
  /**
   * Read the open (`checked: false`) tasks, the completed tasks, or with
   * `null` every task, of every note.
   */
  readAll(checked: boolean | null, signal: AbortSignal): Promise<TaskRead | null>
  /**
   * Read every task of the notes at `paths`. A path that is absent from the
   * result has no task.
   */
  readPaths(paths: readonly string[], signal: AbortSignal): Promise<TaskRead | null>
  /**
   * Read every task of the notes at `paths` in one try. A failed read rejects.
   */
  readPathsOnce(paths: readonly string[]): Promise<TaskRead>
  /**
   * Listen for committed note rows, from any window.
   */
  subscribe(listener: (commit: IndexCommitted) => void): Unlisten
}

class TaskReaderImpl implements TaskReader {
  readonly #deps: TaskReaderDeps

  constructor(deps: TaskReaderDeps) {
    this.#deps = deps
  }

  readAll(checked: boolean | null, signal: AbortSignal): Promise<TaskRead | null> {
    return this.#read(checked, null, signal)
  }

  readPaths(paths: readonly string[], signal: AbortSignal): Promise<TaskRead | null> {
    return this.#read(null, paths, signal)
  }

  readPathsOnce(paths: readonly string[]): Promise<TaskRead> {
    return this.#deps.database.read('index_tasks', { checked: null, paths })
  }

  subscribe(listener: (commit: IndexCommitted) => void): Unlisten {
    const { ipc, logger } = this.#deps
    return listenNow(
      () => {
        return ipc.listen(INDEX_COMMITTED_EVENT, (payload) => {
          const parsed = indexCommittedSchema.safeParse(payload)
          if (parsed.success) {
            listener(parsed.data)
          } else {
            logger.error(`invalid ${INDEX_COMMITTED_EVENT} payload:`, parsed.error)
          }
        })
      },
      (cause) => {
        logger.error(`${INDEX_COMMITTED_EVENT} listener failed:`, cause)
      },
    )
  }

  async #read(
    checked: boolean | null,
    paths: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<TaskRead | null> {
    const { database, clock, logger } = this.#deps
    let delayMs = READ_RETRY_MIN_MS
    while (!signal.aborted) {
      try {
        return await database.read('index_tasks', { checked, paths })
      } catch (error) {
        logger.error(`tasks: read failed, next try in ${delayMs}ms:`, error)
      }
      await clock.sleep(delayMs)
      delayMs = Math.min(delayMs * 2, READ_RETRY_MAX_MS)
    }
    return null
  }
}

export function createTaskReader(deps: TaskReaderDeps): TaskReader {
  return new TaskReaderImpl(deps)
}
