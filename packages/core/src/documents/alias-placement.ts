import { nextAliases } from '../indexing/rename.ts'
import { parseNote } from '../markdown/extract.ts'
import { foldKey } from '../markdown/keys.ts'
import type { NoteDocumentService } from './note-document-service.ts'

/**
 * Old-title alias placement after a settled rename (Plan 07b): the renamed
 * note records the title it renamed *away from* as an alias, so any inbound
 * link the rewrite missed (or couldn't reach) still resolves to this note.
 *
 * Placement routes through the note's session whenever it has one. A direct
 * disk write under a dirty buffer would race the buffer's own save. Only when no session can take the patch
 * does the alias go straight to disk; a loading/clean session reconciles it
 * like any external change, and a header-only patch is body-safe even for
 * protected notes.
 */

/** A settled rename, `from` already known to be a real previous title. */
export interface SettledRename {
  from: string
  to: string
  /** The aliases this session's previous rename added (pruned, never user-authored ones). */
  previousAutoAliases: readonly string[]
}

/** The entries of `next` that `current` did not already carry. */
function addedAliases(current: readonly string[], next: readonly string[]): string[] {
  const kept = new Set(current.map((alias) => foldKey(alias)))
  return next.filter((alias) => !kept.has(foldKey(alias)))
}

/**
 * Record `rename.from` as an alias on the note at `path`, returning the
 * aliases that were added (empty when nothing changed) so the next rename in
 * the chain can prune exactly those. Aliases are computed against the note's
 * **current** frontmatter at placement time — `aliases` replaces the whole
 * key, and any earlier snapshot can be stale (an external edit adopted
 * mid-rewrite, a racing chained rename): replacing from it would drop
 * concurrently-gained entries. Throws on failure; the caller owns reporting.
 */
export async function placeOldTitleAlias(
  noteDocuments: NoteDocumentService,
  path: string,
  rename: SettledRename,
  generation: number,
): Promise<string[]> {
  let added: string[] = []
  await noteDocuments.commitFrontmatter(
    path,
    (source) => {
      added = []
      if (source === null) {
        return null
      }
      const current = parseNote({ path, source }).frontmatter.aliases
      const aliases = nextAliases(current, rename)
      if (aliases === null) {
        return null
      }
      added = addedAliases(current, aliases)
      return { aliases }
    },
    generation,
  )
  return added
}
