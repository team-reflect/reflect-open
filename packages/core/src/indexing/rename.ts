import { wikiLinkSafe } from '../markdown/edit'
import { foldKey } from '../markdown/keys'
import { displayNoteTitle, wikiLinkTargetForTitle } from '../markdown/note-title'
import type { Resolution } from '../markdown/resolve'
import { retitleWikiLinks } from '../markdown/retitle'
import { isWikiLinkSafeText, serializeWikiSuggestionAddress } from './suggest'

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
  /** Links that currently resolve to the renamed note's subject path. */
  backlinks: (path: string) => Promise<RenameBacklink[]>
  read: (path: string) => Promise<string>
  /** Write with the graph generation pre-bound (stale → loud rejection). */
  write: (path: string, content: string) => Promise<void>
  resolve: (target: string) => Promise<Resolution>
}

/** Indexed fields needed to find title-mirroring displays for one subject. */
export interface RenameBacklink {
  sourcePath: string | null
  targetRaw: string | null
  /** Only the *presence* of a pipe display is read; its text may lag the file. */
  alias: string | null
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
  /** Sources whose targets or title-mirroring displays were rewritten. */
  rewritten: string[]
  /** Sources that failed to read/write — skipped; the alias keeps them resolving. */
  failed: string[]
  /**
   * True when `from` now belongs to a different note — its links stay pointed
   * where they are, and the old title must NOT be claimed as an alias (it is
   * theirs). Links that address this note through a *stable* target are not
   * part of that dispute, so their title-mirroring displays still sync and
   * `rewritten` can be non-empty.
   */
  collision: boolean
  /**
   * True when the NEW title's linkable target is not a safe address for this
   * note — unserializable as wiki-link text, or already resolving to a
   * different note — so no target is repointed. Displays still sync: a pipe
   * display is label text, not an address. Unlike a `collision`, the old-title
   * alias MUST still be placed: the un-repointed links keep resolving to this
   * note only through it.
   */
  destinationBlocked: boolean
}

/**
 * Rewrite `[[from]]` → `[[to]]` across every source that links to the renamed
 * note's old title, and update pipe displays that still mirror the old title
 * on any link resolving to the same subject. Serialized (ordering stays
 * deterministic and progress means something); a failing source is skipped,
 * not fatal. The old-title alias keeps its links resolving.
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
  const fromDisplay = wikiLinkSafe(displayNoteTitle(from))
  const toDisplay = wikiLinkSafe(displayNoteTitle(to))

  // Collision guard: if the old title now resolves to a *different* note (a
  // second note owns it as title or alias), the existing links still point
  // somewhere deliberate — rewriting would steal them. A stale index may
  // briefly resolve `from` to the renamed note itself; that's not a collision.
  // Accepted edge: the index lags the watcher debounce, so a note created
  // with the old title inside that sub-second window can be missed here —
  // resolution stays deterministic and the alias still lands, so nothing
  // breaks; the late-created note simply wins future resolutions.
  const resolution = await io.resolve(fromTarget)
  const collision = resolution.kind === 'resolved' && resolution.ref !== path

  // Destination guard: never write an address this note has not been proven
  // to own. An unserializable target (`[[C:\notes Ada]]`) parses back to
  // nothing, and a target already resolving to a *different* note would
  // silently repoint every rewritten link there — the other note's title tier
  // outranks this note's derived alias, so the collision is permanent, not a
  // race. A still-missing destination is fine: the watcher may not have
  // projected the renamed note's own derived alias yet.
  let destinationBlocked = false
  if (!collision) {
    if (serializeWikiSuggestionAddress(toTarget, null) === null) {
      destinationBlocked = true
    } else {
      const destination = await io.resolve(toTarget)
      destinationBlocked = destination.kind === 'resolved' && destination.ref !== path
    }
  }

  // Two candidate sets, because neither is complete alone. The raw old-target
  // query finds `[[Old Title]]` links the freshly reprojected note may have
  // just stopped resolving; the backlink query finds links that address it
  // through a *stable* target (`[[capture-base|Old Title]]`) and so never
  // carried the old title as their target text at all.
  const [titleSources, backlinks] = await Promise.all([
    collision ? Promise.resolve([]) : io.sources(foldKey(fromTarget)),
    io.backlinks(path),
  ])
  // Only *whether* a link carries a pipe display is read from the index, never
  // its text. Reflect rewrites display text itself, so a second retitle can
  // arrive before the watcher reprojects the source the first one just wrote,
  // and an alias-equality filter would silently drop exactly those sources. A
  // pipe's presence is safe to trust: Reflect never adds one to, or removes one
  // from, a link that did not already have one. Whether a display still mirrors
  // the old title is decided on the re-read file, in `retitleWikiLinks`.
  const backlinkSources = new Set<string>()
  const candidateTargets = new Map<string, string>()
  for (const backlink of backlinks) {
    if (
      backlink.sourcePath === null ||
      backlink.targetRaw === null ||
      backlink.alias === null
    ) {
      continue
    }
    backlinkSources.add(backlink.sourcePath)
    const key = foldKey(backlink.targetRaw)
    if (!candidateTargets.has(key)) {
      candidateTargets.set(key, backlink.targetRaw)
    }
  }

  // Whether a target addresses this note is a property of the *target*, not of
  // the source holding it: confirm each distinct one once rather than once per
  // source. The set is this note's own addresses (title, aliases), so it stays
  // small however many backlinks there are.
  const subjectTargetKeys = new Set<string>()
  if (!collision) {
    subjectTargetKeys.add(foldKey(fromTarget))
  }
  const confirmed = await Promise.all(
    [...candidateTargets].map(async ([key, target]) => {
      if (subjectTargetKeys.has(key)) {
        return null
      }
      const candidate = await io.resolve(target)
      return candidate.kind === 'resolved' && candidate.ref === path ? key : null
    }),
  )
  for (const key of confirmed) {
    if (key !== null) {
      subjectTargetKeys.add(key)
    }
  }

  const sources = [...new Set([...titleSources, ...backlinkSources])]
    .filter((source) => source !== path)
    .sort()
  const repoint =
    collision || destinationBlocked ? null : { fromKey: foldKey(fromTarget), to: toTarget }
  const display =
    toDisplay !== '' && isWikiLinkSafeText(toDisplay) ? { from: fromDisplay, to: toDisplay } : null
  const rewritten: string[] = []
  const failed: string[] = []
  let done = 0
  for (const source of sources) {
    try {
      const content = await io.read(source)
      const next = retitleWikiLinks(content, { repoint, display, subjectTargetKeys })
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
  return { rewritten, failed, collision, destinationBlocked }
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
