import type {
  FileMeta,
  LocalNoteRead,
  NoteCreateOutcome,
  NoteRead,
  VaultScanStats,
} from '@reflect/types'
import type { ClockService } from '../ports/clock-service.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'

export type { LocalNoteRead, NoteRead, VaultScanStats } from '@reflect/types'

/**
 * The outcome of {@link NoteFileService.write}.
 */
export interface NoteWriteResult {
  /**
   * The full text now on disk when the disk text had moved past the expected
   * one, else `null`: the merge of both, or the unchanged disk text when the
   * write rejected the mismatch.
   */
  merged: string | null
  /**
   * Lowercase hex SHA-256 of the text now on disk.
   */
  hash: string
  /**
   * The modification time of the file after the write, in epoch milliseconds.
   */
  modifiedMs: number
}

/**
 * Markdown notes by graph-relative path: reads, and the changes that cannot
 * replace the text of a note. Every create and delete is reported to
 * {@link FileChangeService.reportOwnWrite} after it lands.
 */
export interface NoteFileService {
  /**
   * A note's markdown, pinned to the issuing graph session's `generation`.
   */
  read(path: string, generation: number): Promise<string>
  /**
   * A note's markdown and the hash of it, pinned to `generation`.
   */
  readWithHash(path: string, generation: number): Promise<NoteRead>
  /**
   * A note's markdown only when its bytes are local: an iCloud-evicted note
   * reports `evicted` instead of being downloaded. A missing file still
   * rejects with `notFound`.
   */
  readLocal(path: string, generation: number): Promise<LocalNoteRead>
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

/**
 * A {@link NoteFileService} that can also replace the text of a file. Every
 * write is reported to {@link FileChangeService.reportOwnWrite} after it lands.
 */
export interface WritableNoteFileService extends NoteFileService {
  /**
   * Write a note atomically, pinned to `generation`. With `expectedContents`
   * the write is checked: `null` requires a missing file, and a note whose
   * disk text moved past `expectedContents` is merged with it (see
   * {@link NoteWriteResult.merged}). Omitting it writes unconditionally.
   * With `onMismatch: 'reject'` a checked write whose disk text is neither
   * `expectedContents` nor `contents` writes nothing and resolves with the
   * disk text as `merged`.
   */
  write(
    path: string,
    contents: string,
    generation: number,
    expectedContents?: string | null,
    onMismatch?: 'merge' | 'reject',
  ): Promise<NoteWriteResult>
}

export interface NoteFileServiceDeps {
  readonly ipc: IpcBridgeService
  readonly clock: ClockService
  readonly fileChanges: FileChangeService
}

class NoteFileServiceImpl implements WritableNoteFileService {
  readonly #deps: NoteFileServiceDeps

  constructor(deps: NoteFileServiceDeps) {
    this.#deps = deps
  }

  async read(path: string, generation: number): Promise<string> {
    const { content } = await this.readWithHash(path, generation)
    return content
  }

  async readWithHash(path: string, generation: number): Promise<NoteRead> {
    return await this.#deps.ipc.call('note_read', { path, generation })
  }

  async readLocal(path: string, generation: number): Promise<LocalNoteRead> {
    return await this.#deps.ipc.call('note_read_local', { path, generation })
  }

  async write(
    path: string,
    contents: string,
    generation: number,
    expectedContents?: string | null,
    onMismatch?: 'merge' | 'reject',
  ): Promise<NoteWriteResult> {
    const { ipc, clock, fileChanges } = this.#deps
    const outcome = await ipc.call('note_write', {
      path,
      contents,
      generation,
      checkContents: expectedContents === undefined ? null : true,
      expectedContents: expectedContents ?? null,
      rejectMismatch: onMismatch === 'reject' ? true : null,
    })
    const modifiedMs = outcome.modifiedMs ?? clock.now()
    if (onMismatch !== 'reject' || outcome.merged === null) {
      fileChanges.reportOwnWrite([{ path, kind: 'upsert', modifiedMs }])
    }
    return { merged: outcome.merged, hash: outcome.hash, modifiedMs }
  }

  async create(path: string, contents: string, generation: number): Promise<NoteCreateOutcome> {
    const { ipc, clock, fileChanges } = this.#deps
    const outcome = await ipc.call('note_create', { path, contents, generation })
    if (outcome.kind === 'created') {
      fileChanges.reportOwnWrite([
        { path, kind: 'upsert', modifiedMs: outcome.modifiedMs ?? clock.now() },
      ])
    }
    return outcome
  }

  async exists(path: string): Promise<boolean> {
    return await this.#deps.ipc.call('note_exists', { path })
  }

  async delete(path: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('note_delete', { path, generation })
    this.#deps.fileChanges.reportOwnWrite([{ path, kind: 'remove' }])
  }

  async listNotes(generation: number): Promise<FileMeta[]> {
    return await this.#deps.ipc.call('list_files', { generation })
  }

  async listAttachments(generation: number): Promise<FileMeta[]> {
    return await this.#deps.ipc.call('list_attachments', { generation })
  }

  async listDir(dir: string, generation: number): Promise<FileMeta[]> {
    return await this.#deps.ipc.call('dir_list', { dir, generation })
  }

  async vaultScanStats(generation: number): Promise<VaultScanStats> {
    return await this.#deps.ipc.call('vault_scan_stats', { generation })
  }
}

export function createNoteFileService(deps: NoteFileServiceDeps): WritableNoteFileService {
  return new NoteFileServiceImpl(deps)
}
