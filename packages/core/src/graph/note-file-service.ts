import { z } from 'zod'
import type { ClockService } from '../ports/clock-service.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import {
  fileMetaSchema,
  noteCreateOutcomeSchema,
  type FileMeta,
  type NoteCreateOutcome,
} from './schemas.ts'

/**

 * Commands that return `()` from Rust serialize as `null` over IPC.

 */
const voidSchema = z.null()

const localNoteReadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('content'), content: z.string() }),
  z.object({ kind: z.literal('evicted') }),
])

/**

 * How a {@link NoteFileService.readLocal} request found the note on disk.

 */
export type LocalNoteRead = z.infer<typeof localNoteReadSchema>

const vaultScanStatsSchema = z.object({
  notes: z.number(),
  attachments: z.number(),
  skipped: z.number(),
})

export type VaultScanStats = z.infer<typeof vaultScanStatsSchema>

const noteWriteOutcomeSchema = z.object({
  modifiedMs: z.number().nullable(),
  merged: z.string().nullable(),
})

/**
 * The outcome of {@link NoteFileService.write}.
 */
export interface NoteWriteResult {
  /**
   * The full text now on disk when the write merged with a newer disk text, else `null`.
   */
  merged: string | null
}

/**
 * Markdown notes by graph-relative path. Every write, create and delete is
 * reported to {@link FileChangeService.reportOwnWrite} after it lands.
 */
export interface NoteFileService {
  /**
   * A note's markdown, pinned to the issuing graph session's `generation`.
   */
  read(path: string, generation: number): Promise<string>
  /**
   * A note's markdown only when its bytes are local: an iCloud-evicted note
   * reports `evicted` instead of being downloaded. A missing file still
   * rejects with `notFound`.
   */
  readLocal(path: string, generation: number): Promise<LocalNoteRead>
  /**
   * Write a note atomically, pinned to `generation`. With `expectedContents`
   * the write is checked: `null` requires a missing file, and a note whose
   * disk text moved past `expectedContents` is merged with it (see
   * {@link NoteWriteResult.merged}). Omitting it writes unconditionally.
   */
  write(
    path: string,
    contents: string,
    generation: number,
    expectedContents?: string | null,
  ): Promise<NoteWriteResult>
  /**
   * Create a note only when `path` is free. A collision is returned, never overwritten.
   */
  create(path: string, contents: string, generation: number): Promise<NoteCreateOutcome>
  /**
   * Whether a file exists at `path` on disk right now.
   */
  exists(path: string): Promise<boolean>
  /**
   * Move a note to the OS trash (`.reflect/trash/` on mobile).
   */
  delete(path: string, generation: number): Promise<void>
  /**
   * Every eligible Markdown note in the graph.
   */
  listNotes(generation: number): Promise<FileMeta[]>
  /**
   * Every supported local attachment in the graph.
   */
  listAttachments(generation: number): Promise<FileMeta[]>
  /**
   * Every file under a graph-relative directory. A missing directory lists as empty.
   */
  listDir(dir: string, generation: number): Promise<FileMeta[]>
  /**
   * Counts from the vault catalog, including what the walk skipped.
   */
  vaultScanStats(generation: number): Promise<VaultScanStats>
}

export interface NoteFileServiceDeps {
  readonly ipc: IpcBridgeService
  readonly clock: ClockService
  readonly fileChanges: FileChangeService
}

class NoteFileServiceImpl implements NoteFileService {
  readonly #deps: NoteFileServiceDeps

  constructor(deps: NoteFileServiceDeps) {
    this.#deps = deps
  }

  async read(path: string, generation: number): Promise<string> {
    return await this.#deps.ipc.call('note_read', { path, generation }, z.string())
  }

  async readLocal(path: string, generation: number): Promise<LocalNoteRead> {
    return await this.#deps.ipc.call('note_read_local', { path, generation }, localNoteReadSchema)
  }

  async write(
    path: string,
    contents: string,
    generation: number,
    expectedContents?: string | null,
  ): Promise<NoteWriteResult> {
    const { ipc, clock, fileChanges } = this.#deps
    const outcome = await ipc.call(
      'note_write',
      {
        path,
        contents,
        generation,
        ...(expectedContents === undefined ? {} : { checkContents: true, expectedContents }),
      },
      noteWriteOutcomeSchema,
    )
    const modifiedMs = outcome.modifiedMs ?? clock.now()
    fileChanges.reportOwnWrite([{ path, kind: 'upsert', modifiedMs }])
    return { merged: outcome.merged }
  }

  async create(path: string, contents: string, generation: number): Promise<NoteCreateOutcome> {
    const { ipc, clock, fileChanges } = this.#deps
    const outcome = await ipc.call(
      'note_create',
      { path, contents, generation },
      noteCreateOutcomeSchema,
    )
    if (outcome.kind === 'created') {
      fileChanges.reportOwnWrite([
        { path, kind: 'upsert', modifiedMs: outcome.modifiedMs ?? clock.now() },
      ])
    }
    return outcome
  }

  async exists(path: string): Promise<boolean> {
    return await this.#deps.ipc.call('note_exists', { path }, z.boolean())
  }

  async delete(path: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('note_delete', { path, generation }, voidSchema)
    this.#deps.fileChanges.reportOwnWrite([{ path, kind: 'remove' }])
  }

  async listNotes(generation: number): Promise<FileMeta[]> {
    return await this.#deps.ipc.call('list_files', { generation }, z.array(fileMetaSchema))
  }

  async listAttachments(generation: number): Promise<FileMeta[]> {
    return await this.#deps.ipc.call('list_attachments', { generation }, z.array(fileMetaSchema))
  }

  async listDir(dir: string, generation: number): Promise<FileMeta[]> {
    return await this.#deps.ipc.call('dir_list', { dir, generation }, z.array(fileMetaSchema))
  }

  async vaultScanStats(generation: number): Promise<VaultScanStats> {
    return await this.#deps.ipc.call('vault_scan_stats', { generation }, vaultScanStatsSchema)
  }
}

export function createNoteFileService(deps: NoteFileServiceDeps): NoteFileService {
  return new NoteFileServiceImpl(deps)
}
