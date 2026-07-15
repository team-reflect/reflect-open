import {
  nextAliases,
  parseNote,
  readNote,
  upsertFrontmatter,
  writeNoteIfUnchanged,
} from '@reflect/core'
import { openSession } from './open-documents'

/**
 * Old-title alias placement after a settled rename (Plan 07b): the renamed
 * note records the title it renamed *away from* as an alias, so any inbound
 * link the rewrite missed (or couldn't reach) still resolves to this note.
 *
 * Placement routes through the live session whenever the note is open — in
 * the renaming pane or a *reopened* one (the open-documents service is the
 * one liveness signal). A direct disk write under a reopened dirty buffer
 * would park a conflict caused by our own background work, and "keep mine"
 * would silently drop the alias. Only when no session can take the patch
 * does the alias go straight to disk; a loading/clean session reconciles it
 * like any external change, and a header-only patch is body-safe even for
 * protected notes.
 */

/** A settled rename, `from` already known to be a real previous title. */
export interface SettledRename {
  from: string
  to: string
  /** The alias auto-added by this session's previous rename (prune candidate). */
  previousAutoAlias: string | null
}

/**
 * Record `rename.from` as an alias on the note at `path`. Aliases are
 * computed against the note's **current** frontmatter at placement time —
 * `aliases` replaces the whole key, and any earlier snapshot can be stale (an
 * external edit adopted mid-rewrite, a racing chained rename): replacing from
 * it would drop concurrently-gained entries. Throws on failure; the caller
 * owns reporting.
 */
export async function placeOldTitleAlias(
  path: string,
  rename: SettledRename,
  generation: number,
): Promise<void> {
  const aliasesOf = (source: string): string[] => parseNote({ path, source }).frontmatter.aliases
  const owner = openSession(path)
  let placed = false
  if (owner !== null) {
    // Read and patch in the same tick (no await between): atomic against the
    // session. Through its frontmatter channel — the editor view never
    // churns — and flushed rather than riding the debounce: a settle is
    // exactly the moment to persist, and quit-time teardown awaits this.
    const aliases = nextAliases(aliasesOf(owner.content()), rename)
    placed = aliases === null || owner.updateFrontmatter({ aliases })
    if (placed && aliases !== null) {
      await owner.flush()
    }
  }
  if (!placed) {
    const content = await readNote(path)
    const aliases = nextAliases(aliasesOf(content), rename)
    if (aliases !== null) {
      const patched = upsertFrontmatter(content, { aliases })
      if (patched !== content) {
        const outcome = await writeNoteIfUnchanged(path, content, patched, generation)
        if (outcome.kind === 'changed') {
          throw new Error('The note changed or was removed before alias placement landed.')
        }
      }
    }
  }
}
