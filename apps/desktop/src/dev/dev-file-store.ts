import type { FileMeta } from '@reflect/core'

/** One in-memory markdown file: contents plus a last-modified stamp. */
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
  /** Every markdown note under `daily/` and `notes/` (the `list_files` view). */
  list: () => FileMeta[]
  /** Files under a graph-relative directory prefix (the `dir_list` view). */
  listDir: (dir: string) => FileMeta[]
  /** A note's markdown, or `null` when the path doesn't exist. */
  read: (path: string) => string | null
  exists: (path: string) => boolean
  /** Write a file and return the `modifiedMs` it was stamped with (the
   * `note_write` contract: the caller's index echo carries this stamp). */
  write: (path: string, contents: string) => number
  /** Delete a path; a missing path is a no-op (mirrors trashing semantics). */
  remove: (path: string) => void
  /** Rename a file; refuses (returns false) when the destination exists. */
  move: (from: string, to: string) => boolean
}

/** UTF-8 byte length — `FileMeta.size` parity with the Rust listing. */
function byteSize(contents: string): number {
  return new TextEncoder().encode(contents).length
}

/**
 * Create the in-memory file store, pre-populated with `seed` (path →
 * markdown). Seeded files get staggered past mtimes so recency ordering is
 * visibly non-uniform in list surfaces.
 */
export function createDevFileStore(seed: Record<string, string>): DevFileStore {
  const files = new Map<string, DevFile>()
  const seedEntries = Object.entries(seed)
  seedEntries.forEach(([path, contents], position) => {
    // Older seeds get older stamps, one minute apart, ending "now".
    const modifiedMs = Date.now() - (seedEntries.length - position) * 60_000
    files.set(path, { contents, modifiedMs })
  })

  const toMeta = ([path, file]: [string, DevFile]): FileMeta => ({
    path,
    size: byteSize(file.contents),
    modifiedMs: file.modifiedMs,
  })

  return {
    list: () =>
      [...files.entries()]
        .filter(
          ([path]) =>
            (path.startsWith('daily/') || path.startsWith('notes/')) && path.endsWith('.md'),
        )
        .map(toMeta),
    listDir: (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      return [...files.entries()].filter(([path]) => path.startsWith(prefix)).map(toMeta)
    },
    read: (path) => files.get(path)?.contents ?? null,
    exists: (path) => files.has(path),
    write: (path, contents) => {
      const modifiedMs = Date.now()
      files.set(path, { contents, modifiedMs })
      return modifiedMs
    },
    remove: (path) => {
      files.delete(path)
    },
    move: (from, to) => {
      const file = files.get(from)
      if (file === undefined || files.has(to)) {
        return false
      }
      files.delete(from)
      files.set(to, file)
      return true
    },
  }
}
