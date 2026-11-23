import type { Unlisten } from '../unlisten.ts'

/**
 * What a source knows about a path it reports as dirty.
 */
export interface DirtyHint {
  /**
   * Whether the file exists (`upsert`) or is gone (`remove`). Defaults to `upsert`.
   */
  readonly kind?: 'upsert' | 'remove' | undefined
  /**
   * The file's last-modified time (epoch ms).
   */
  readonly modifiedMs?: number | undefined
  /**
   * The file's full text, which saves the read.
   */
  readonly content?: string | undefined
  /**
   * Write the row even when the file's hash matches the stored one.
   */
  readonly force?: boolean | undefined
  /**
   * The path belongs to a whole-graph pass, which reports its own completion.
   */
  readonly bulk?: boolean | undefined
}

/**
 * One path whose file may differ from its index rows.
 */
export interface DirtyEntry {
  readonly path: string
  readonly kind: 'upsert' | 'remove'
  readonly modifiedMs: number | undefined
  readonly content: string | undefined
  readonly force: boolean
  readonly bulk: boolean
}

/**
 * The paths whose files may differ from the index, one entry per path.
 */
export interface DirtySet {
  /**
   * Mark `path` dirty. The hint replaces the path's earlier hint, so an add
   * without `content` drops older content. Only `force` survives a later add,
   * and an entry is `bulk` only while every add for it was.
   */
  add(path: string, hint?: DirtyHint): void
  /**
   * Remove and return every entry, oldest path first.
   */
  take(): DirtyEntry[]
  /**
   * Remove and return the entry of `path`, if it is dirty.
   */
  takePath(path: string): DirtyEntry | undefined
  /**
   * Put back entries that {@link DirtySet.take} returned. A path marked dirty
   * since then keeps its newer hint.
   */
  restore(entries: readonly DirtyEntry[]): void
  /**
   * Whether `path` is dirty.
   */
  has(path: string): boolean
  /**
   * The number of dirty paths.
   */
  size(): number
  /**
   * Call `listener` after each {@link DirtySet.add}.
   */
  subscribe(listener: () => void): Unlisten
}

class DirtySetImpl implements DirtySet {
  readonly #entries = new Map<string, DirtyEntry>()
  readonly #listeners = new Set<() => void>()

  add(path: string, hint?: DirtyHint): void {
    const earlier = this.#entries.get(path)
    this.#entries.set(path, {
      path,
      kind: hint?.kind ?? 'upsert',
      modifiedMs: hint?.modifiedMs,
      content: hint?.content,
      force: (hint?.force ?? false) || (earlier?.force ?? false),
      bulk: (hint?.bulk ?? false) && (earlier?.bulk ?? true),
    })
    for (const listener of this.#listeners) {
      listener()
    }
  }

  take(): DirtyEntry[] {
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    return entries
  }

  takePath(path: string): DirtyEntry | undefined {
    const entry = this.#entries.get(path)
    this.#entries.delete(path)
    return entry
  }

  restore(entries: readonly DirtyEntry[]): void {
    for (const entry of entries) {
      const newer = this.#entries.get(entry.path)
      this.#entries.set(
        entry.path,
        newer === undefined
          ? entry
          : { ...newer, force: newer.force || entry.force, bulk: newer.bulk && entry.bulk },
      )
    }
  }

  has(path: string): boolean {
    return this.#entries.has(path)
  }

  size(): number {
    return this.#entries.size
  }

  subscribe(listener: () => void): Unlisten {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}

export function createDirtySet(): DirtySet {
  return new DirtySetImpl()
}
