import { renameWikiLink } from '../markdown/edit'
import { foldKey } from '../markdown/keys'
import { wikiLinkTargetForTitle } from '../markdown/note-title'
import type { Resolution } from '../markdown/resolve'

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
  /** True when `from` now belongs to a different note — links were left alone. */
  collision: boolean
}

/**
 * Rewrite the old title's linkable target to the new title's linkable target
 * across every source. Rich title Markdown cannot be nested inside `[[...]]`,
 * so this deliberately uses the same visible-title mapping as autocomplete.
 * Serialized (ordering stays deterministic and progress means something); a
 * failing source is skipped, not fatal — the old-target alias keeps its links
 * resolving.
 */
export async function rewriteLinksForTitleChange(
  options: TitleRenameRewriteOptions,
): Promise<TitleRenameRewriteResult> {
  const { path, from, to, io, onProgress } = options
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
    return { rewritten: [], failed: [], collision: true }
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
  return { rewritten, failed, collision: false }
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
