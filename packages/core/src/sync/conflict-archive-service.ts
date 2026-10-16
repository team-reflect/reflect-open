import { z } from 'zod'
import { requireGraphSession, type GraphSessionSource } from '../graph/graph-session.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'

const archivedVersionSchema = z.object({
  name: z.string(),
  modifiedMs: z.number(),
  device: z.string(),
  size: z.number(),
})

const archivedVersionsSchema = z.array(archivedVersionSchema)

/**
 * One earlier version of a note that a merge or an overwrite set aside.
 */
export type ArchivedVersion = z.infer<typeof archivedVersionSchema>

export interface ConflictArchiveServiceDeps {
  readonly ipc: IpcBridgeService
  readonly noteFile: NoteFileService
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
   * Write an archived version over the note, without checking the file on disk.
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
    const content = await this.read(path, name)
    const { generation } = requireGraphSession(this.#deps.graphSession)
    await this.#deps.noteFile.write(path, content, generation)
  }
}

export function createConflictArchiveService(
  deps: ConflictArchiveServiceDeps,
): ConflictArchiveService {
  return new ConflictArchiveServiceImpl(deps)
}
