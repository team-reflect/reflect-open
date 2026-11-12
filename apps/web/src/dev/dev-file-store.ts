import { isNotePath, type FileMeta, type NoteCreateOutcome } from '@reflect/core'

/**
 * One in-memory markdown file: contents plus a last-modified stamp.
 */
interface DevFile {
  contents: string
  modifiedMs: number
}

/**
 * The dev bridge's filesystem: a plain in-memory map of graph-relative paths
 * to markdown, standing in for the Rust shell's `fs` commands. Mutations stamp
 * `modifiedMs` with the current time so recency sorts and the indexer's
 * hash-reconcile behave like real files.
 */
export interface DevFileStore {
  /**
   * Every eligible Markdown note anywhere in the graph (`list_files`).
   */
  list(): FileMeta[]
  /**
   * Files under a graph-relative directory prefix (the `dir_list` view).
   */
  listDir(dir: string): FileMeta[]
  /**
   * A note's markdown, or `null` when the path doesn't exist.
   */
  read(path: string): string | null
  exists(path: string): boolean
  /**
   * Write a file and return the `modifiedMs` it was stamped with (the
   * `note_write` contract: the caller's index echo carries this stamp).
   */
  write(path: string, contents: string): number
  /**
   * Create a file only when its path is free; never replaces existing bytes.
   */
  create(path: string, contents: string): NoteCreateOutcome
  /**
   * Delete a path; a missing path is a no-op (mirrors trashing semantics).
   */
  remove(path: string): void
  /**
   * Rename a file; refuses (returns false) when the destination exists.
   */
  move(from: string, to: string): boolean
}

/**
 * UTF-8 byte length — `FileMeta.size` parity with the Rust listing.
 */
function byteSize(contents: string): number {
  return new TextEncoder().encode(contents).length
}

class DevFileStoreImpl implements DevFileStore {
  readonly #files = new Map<string, DevFile>()

  constructor(seed: Record<string, string>) {
    const seedEntries = Object.entries(seed)
    for (const [position, [path, contents]] of seedEntries.entries()) {
      // Older seeds get older stamps, one minute apart, ending "now".
      const modifiedMs = Date.now() - (seedEntries.length - position) * 60_000
      this.#files.set(path, { contents, modifiedMs })
    }
  }

  list(): FileMeta[] {
    return [...this.#files].filter(([path]) => isNotePath(path)).map(toMeta)
  }

  listDir(dir: string): FileMeta[] {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    return [...this.#files].filter(([path]) => path.startsWith(prefix)).map(toMeta)
  }

  read(path: string): string | null {
    return this.#files.get(path)?.contents ?? null
  }

  exists(path: string): boolean {
    return this.#files.has(path)
  }

  write(path: string, contents: string): number {
    const modifiedMs = Date.now()
    this.#files.set(path, { contents, modifiedMs })
    return modifiedMs
  }

  create(path: string, contents: string): NoteCreateOutcome {
    if (this.#files.has(path)) {
      return { kind: 'collision' }
    }
    const modifiedMs = Date.now()
    this.#files.set(path, { contents, modifiedMs })
    return { kind: 'created', modifiedMs }
  }

  remove(path: string): void {
    this.#files.delete(path)
  }

  move(from: string, to: string): boolean {
    const file = this.#files.get(from)
    if (file === undefined || this.#files.has(to)) {
      return false
    }
    this.#files.delete(from)
    this.#files.set(to, file)
    return true
  }
}

function toMeta([path, file]: [string, DevFile]): FileMeta {
  return { path, size: byteSize(file.contents), modifiedMs: file.modifiedMs }
}

/**
 * Create the in-memory file store, pre-populated with `seed` (path →
 * markdown). Seeded files get staggered past mtimes so recency ordering is
 * visibly non-uniform in list surfaces.
 */
export function createDevFileStore(seed: Record<string, string>): DevFileStore {
  return new DevFileStoreImpl(seed)
}
