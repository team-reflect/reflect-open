import { wikiLinkSafe } from '../markdown/edit'
import { parseNote } from '../markdown/extract'
import { foldKey } from '../markdown/keys'
import { displayNoteTitle, wikiLinkTargetForTitle } from '../markdown/note-title'
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

interface Splice {
  from: number
  to: number
  text: string
}

function applySplices(source: string, splices: Splice[]): string {
  let result = source
  for (const splice of [...splices].sort((first, second) => second.from - first.from)) {
    result = result.slice(0, splice.from) + splice.text + result.slice(splice.to)
  }
  return result
}

async function rewriteSourceLinks(options: {
  content: string
  path: string
  fromTarget: string
  toTarget: string
  fromDisplay: string
  toDisplay: string
  rewriteTargets: boolean
  oldTargetBelongsToSubject: boolean
  backlinkTargetKeys: ReadonlySet<string>
  resolve: (target: string) => Promise<Resolution>
}): Promise<string> {
  const {
    content,
    path,
    fromTarget,
    toTarget,
    fromDisplay,
    toDisplay,
    rewriteTargets,
    oldTargetBelongsToSubject,
    backlinkTargetKeys,
    resolve,
  } = options
  const fromTargetKey = fromTarget.trim().toLowerCase()
  const displayAddressable =
    toDisplay !== '' && serializeWikiSuggestionAddress('subject', toDisplay) !== null
  const splices: Splice[] = []
  const subjectResolution = new Map<string, Promise<boolean>>()

  for (const link of parseNote({ path: '', source: content }).wikiLinks) {
    const oldTarget = link.target.toLowerCase() === fromTargetKey
    let targetsSubject = oldTarget && oldTargetBelongsToSubject
    const targetKey = foldKey(link.target)
    if (!targetsSubject && backlinkTargetKeys.has(targetKey)) {
      let resolvesToSubject = subjectResolution.get(targetKey)
      if (resolvesToSubject === undefined) {
        resolvesToSubject = resolve(link.target).then(
          (resolution) => resolution.kind === 'resolved' && resolution.ref === path,
        )
        subjectResolution.set(targetKey, resolvesToSubject)
      }
      targetsSubject = await resolvesToSubject
    }

    const target = oldTarget && rewriteTargets ? toTarget : link.target
    const alias =
      targetsSubject && displayAddressable && link.alias === fromDisplay
        ? toDisplay
        : (link.alias ?? null)
    if (target === link.target && alias === (link.alias ?? null)) {
      continue
    }
    splices.push({
      from: link.from,
      to: link.to,
      text: alias === null ? `[[${target}]]` : `[[${target}|${alias}]]`,
    })
  }

  return applySplices(content, splices)
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

  const [titleSources, backlinks] = await Promise.all([
    collision ? Promise.resolve([]) : io.sources(foldKey(fromTarget)),
    io.backlinks(path),
  ])
  const backlinkTargets = new Map<string, Set<string>>()
  for (const backlink of backlinks) {
    if (
      backlink.sourcePath === null ||
      backlink.targetRaw === null ||
      backlink.alias !== fromDisplay
    ) {
      continue
    }
    const targets = backlinkTargets.get(backlink.sourcePath) ?? new Set<string>()
    targets.add(foldKey(backlink.targetRaw))
    backlinkTargets.set(backlink.sourcePath, targets)
  }
  const sources = [...new Set([...titleSources, ...backlinkTargets.keys()])]
    .filter((source) => source !== path)
    .sort()
  const rewritten: string[] = []
  const failed: string[] = []
  let done = 0
  for (const source of sources) {
    try {
      const content = await io.read(source)
      const next = await rewriteSourceLinks({
        content,
        path,
        fromTarget,
        toTarget,
        fromDisplay,
        toDisplay,
        rewriteTargets: !collision && !destinationBlocked,
        oldTargetBelongsToSubject: !collision,
        backlinkTargetKeys: backlinkTargets.get(source) ?? new Set<string>(),
        resolve: io.resolve,
      })
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
