import { z } from 'zod'
import { requireGraphSession, type GraphSessionSource } from '../graph/graph-session.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { ClockService } from '../ports/clock-service.ts'

const archivedVersionSchema = z.object({
  name: z.string(),
  modifiedMs: z.number(),
  device: z.string(),
  size: z.number(),
})

const archivedVersionsSchema = z.array(archivedVersionSchema)

const restoreOutcomeSchema = z.object({
  modifiedMs: z.number().nullable(),
  merged: z
    .object({
      content: z.string(),
      kind: z.enum(['exact', 'reconciled']),
    })
    .optional(),
})

/**
 * One earlier version of a note that a merge or an overwrite set aside.
 */
export type ArchivedVersion = z.infer<typeof archivedVersionSchema>

export interface ConflictArchiveServiceDeps {
  readonly ipc: IpcBridgeService
  readonly clock: ClockService
  readonly fileChanges: FileChangeService
  readonly graphSession: GraphSessionSource
}

/**
 * The earlier versions of a note that sync set aside, and a way to bring one back.
 */
export interface ConflictArchiveService {
  /**
   * The archived versions of the note, newest first. Empty when it has none.
   */
  list(path: string): Promise<ArchivedVersion[]>
  /**
   * The text of one archived version, named as {@link list} returned it.
   */
  read(path: string, name: string): Promise<string>
  /**
   * Write an archived version over the note. Every change is reported to
   * {@link FileChangeService.reportOwnWrite} after it lands.
   */
  restore(path: string, name: string): Promise<void>
}

class ConflictArchiveServiceImpl implements ConflictArchiveService {
  readonly #deps: ConflictArchiveServiceDeps

  constructor(deps: ConflictArchiveServiceDeps) {
    this.#deps = deps
  }

  async list(path: string): Promise<ArchivedVersion[]> {
    const { generation } = requireGraphSession(this.#deps.graphSession)
    return await this.#deps.ipc.call(
      'conflict_archive_list',
      { path, generation },
      archivedVersionsSchema,
    )
  }

  async read(path: string, name: string): Promise<string> {
    const { generation } = requireGraphSession(this.#deps.graphSession)
    return await this.#deps.ipc.call(
      'conflict_archive_read',
      { path, name, generation },
      z.string(),
    )
  }

  async restore(path: string, name: string): Promise<void> {
    const { ipc, clock, fileChanges, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    const outcome = await ipc.call(
      'conflict_archive_restore',
      { path, name, generation },
      restoreOutcomeSchema,
    )
    fileChanges.reportOwnWrite([
      { path, kind: 'upsert', modifiedMs: outcome.modifiedMs ?? clock.now() },
    ])
  }
}

export function createConflictArchiveService(
  deps: ConflictArchiveServiceDeps,
): ConflictArchiveService {
  return new ConflictArchiveServiceImpl(deps)
}
