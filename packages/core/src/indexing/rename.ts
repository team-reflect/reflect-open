import { renameWikiLink } from '../markdown/edit'
import { foldKey } from '../markdown/keys'
import { wikiLinkTargetForTitle } from '../markdown/note-title'
import type { Resolution } from '../markdown/resolve'
import { serializeWikiSuggestionAddress } from './suggest'

/**
 * The rename-rewrite pipeline (Plan 07b): when a note's settled title changes,
 * rewrite the `[[old title]]` links that point at it and preserve the old
 * title as an alias. Orchestration only — data access is injected (DI per
 * conventions §3) so the policy is testable without a database, and the
 * desktop binds the index query, file commands (generation-pinned), and the
 * shared resolver.
 */

export interface RenameIo {
  /** Distinct source paths of links whose folded target key matches. */
  sources: (targetKey: string) => Promise<string[]>
  read: (path: string) => Promise<string>
  /** Write with the graph generation pre-bound (stale → loud rejection). */
  write: (path: string, content: string) => Promise<void>
  resolve: (target: string) => Promise<Resolution>
}

export interface TitleRenameRewriteOptions {
  /** Path of the renamed note. */
  path: string
  from: string
  to: string
  io: RenameIo
  onProgress?: (done: number, total: number) => void
}

export interface TitleRenameRewriteResult {
  /** Sources whose links were rewritten. */
  rewritten: string[]
  /** Sources that failed to read/write — skipped; the alias keeps them resolving. */
  failed: string[]
  /**
   * True when `from` now belongs to a different note — links were left alone,
   * and the old title must NOT be claimed as an alias (it is theirs).
   */
  collision: boolean
  /**
   * True when the NEW title's linkable target is not a safe address for this
   * note — unserializable as wiki-link text, or already resolving to a
   * different note — so links were left alone. Unlike a `collision`, the
   * old-title alias MUST still be placed: the untouched links keep resolving
   * to this note only through it.
   */
  destinationBlocked: boolean
}

/**
 * Rewrite `[[from]]` → `[[to]]` across every source that links to the renamed
 * note's old title. Serialized (ordering stays deterministic and progress
 * means something); a failing source is skipped, not fatal — the old-title
 * alias keeps its links resolving.
 */
export async function rewriteLinksForTitleChange(
  options: TitleRenameRewriteOptions,
): Promise<TitleRenameRewriteResult> {
  const { path, from, to, io, onProgress } = options
  // Links carry the linkable form of a title, not the raw title — for a rich
  // title (`Meeting with [[Ada]]`) the two differ, and only the linkable form
  // ever appears inside `[[…]]`. Rewrite in that space.
  const fromTarget = wikiLinkTargetForTitle(from)
  const toTarget = wikiLinkTargetForTitle(to)

  // Collision guard: if the old title now resolves to a *different* note (a
  // second note owns it as title or alias), the existing links still point
  // somewhere deliberate — rewriting would steal them. A stale index may
  // briefly resolve `from` to the renamed note itself; that's not a collision.
  // Accepted edge: the index lags the watcher debounce, so a note created
  // with the old title inside that sub-second window can be missed here —
  // resolution stays deterministic and the alias still lands, so nothing
  // breaks; the late-created note simply wins future resolutions.
  const resolution = await io.resolve(fromTarget)
  if (resolution.kind === 'resolved' && resolution.ref !== path) {
    return { rewritten: [], failed: [], collision: true, destinationBlocked: false }
  }

  // Destination guard: never write an address this note has not been proven
  // to own. An unserializable target (`[[C:\notes Ada]]`) parses back to
  // nothing, and a target already resolving to a *different* note would
  // silently repoint every rewritten link there — the other note's title tier
  // outranks this note's derived alias, so the collision is permanent, not a
  // race. A still-missing destination is fine: the watcher may not have
  // projected the renamed note's own derived alias yet.
  if (serializeWikiSuggestionAddress(toTarget, null) === null) {
    return { rewritten: [], failed: [], collision: false, destinationBlocked: true }
  }
  const destination = await io.resolve(toTarget)
  if (destination.kind === 'resolved' && destination.ref !== path) {
    return { rewritten: [], failed: [], collision: false, destinationBlocked: true }
  }

  const sources = (await io.sources(foldKey(fromTarget))).filter((source) => source !== path)
  const rewritten: string[] = []
  const failed: string[] = []
  let done = 0
  for (const source of sources) {
    try {
      const content = await io.read(source)
      const next = renameWikiLink(content, fromTarget, toTarget)
      if (next !== content) {
        await io.write(source, next)
        rewritten.push(source)
      }
    } catch {
      failed.push(source)
    }
    done += 1
    onProgress?.(done, sources.length)
  }
  return { rewritten, failed, collision: false, destinationBlocked: false }
}

/**
 * The renamed note's `aliases` after a rename, or `null` when nothing changes:
 * the previous auto-added alias (an intermediate title from this session's
 * rename chain) is pruned, and the old title joins so links Reflect couldn't
 * rewrite — and external ones — still resolve.
 */
export function nextAliases(
  current: string[],
  rename: { from: string; to: string; previousAutoAlias: string | null },
): string[] | null {
  const { from, to, previousAutoAlias } = rename
  const next = current.filter(
    (alias) => previousAutoAlias === null || foldKey(alias) !== foldKey(previousAutoAlias),
  )
  const fromKey = foldKey(from)
  const redundant =
    foldKey(to) === fromKey || next.some((alias) => foldKey(alias) === fromKey)
  if (!redundant) {
    next.push(from)
  }
  const unchanged =
    next.length === current.length && next.every((alias, i) => alias === current[i])
  return unchanged ? null : next
}
