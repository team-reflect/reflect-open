import { indexMarkdownNoteReference, notePathKey, wikiNotePath } from '../graph/local-note-reference'
import { renameWikiLink } from '../markdown/edit'
import { parseNote } from '../markdown/extract'
import { foldKey } from '../markdown/keys'
import type { ExistingWikiTargetResolution } from '../graph/resolve-existing-wiki-target'

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
  /** Resolve without collapsing duplicate owners to an arbitrary first match. */
  resolve: (target: string) => Promise<ExistingWikiTargetResolution>
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

/** A source rewrite prepared before the managed note is moved. */
export interface PreparedNoteMoveRewrite {
  readonly path: string
  readonly before: string
  readonly after: string
}

/** Inputs needed to prepare every safe reference rewrite for one managed move. */
export interface PrepareNoteMoveRewritesOptions {
  /** Current graph-relative path of the managed note being moved. */
  readonly fromPath: string
  /** Destination graph-relative path of the managed note being moved. */
  readonly toPath: string
  /** Generation-pinned live note manifest: every path is read and parsed. */
  readonly notePaths: readonly string[]
  /** Read one path from the same generation-pinned graph snapshot. */
  readonly read: (path: string) => Promise<string>
}

/** The complete, still-unwritten result of preparing one managed note move. */
export interface PreparedNoteMoveRewrites {
  /** Byte-exact source replacements that are safe to write before the move. */
  readonly rewrites: readonly PreparedNoteMoveRewrite[]
  /**
   * Sources whose contents changed, became unreadable, or were ambiguous
   * before a safe rewrite was prepared. A non-empty list means the caller must
   * abort the move and leave every prepared rewrite unwritten.
   */
  readonly failed: readonly string[]
}

interface SourceSplice {
  readonly from: number
  readonly to: number
  readonly text: string
}

function applySourceSplices(source: string, splices: readonly SourceSplice[]): string {
  let result = source
  for (const splice of [...splices].sort((left, right) => right.from - left.from)) {
    result = result.slice(0, splice.from) + splice.text + result.slice(splice.to)
  }
  return result
}

function splitFragment(target: string): { path: string; fragment: string } {
  const hash = target.indexOf('#')
  return hash === -1
    ? { path: target, fragment: '' }
    : { path: target.slice(0, hash), fragment: target.slice(hash) }
}

function stripMarkdownExtension(path: string): string {
  return path.replace(/\.md$/i, '')
}

function wikiTargetAfterMove(target: string, toPath: string): string {
  const authored = splitFragment(target)
  const keepExtension = /\.md$/i.test(authored.path.trim())
  const path = keepExtension ? toPath : stripMarkdownExtension(toPath)
  return `${path}${authored.fragment}`
}

function relativePath(fromFile: string, toFile: string): string {
  const from = fromFile.split('/')
  from.pop()
  const to = toFile.split('/')
  let common = 0
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common += 1
  }
  return [...Array.from({ length: from.length - common }, () => '..'), ...to.slice(common)].join('/')
}

function markdownHrefAfterMove(href: string, sourcePath: string, toPath: string): string {
  const authored = splitFragment(href)
  if (authored.path === '') {
    return href
  }
  const keepExtension = /\.md$/i.test(authored.path)
  const rootRelative = authored.path.startsWith('/')
  const target = keepExtension ? toPath : stripMarkdownExtension(toPath)
  const path = rootRelative ? `/${target}` : relativePath(sourcePath, target)
  const explicitSameDirectory = authored.path.startsWith('./') && !path.startsWith('.')
  return `${explicitSameDirectory ? `./${path}` : path}${authored.fragment}`
}

function markdownReferenceMatchesLiveTarget(
  pathKey: string,
  alternatePathKey: string | null,
  targetPathKey: string,
  livePathKeyOwners: ReadonlyMap<string, number>,
): boolean | null {
  const candidates = [...new Set([pathKey, alternatePathKey].filter((key) => key !== null))]
  if (!candidates.includes(targetPathKey)) {
    return false
  }
  const liveOwnerCount = candidates.reduce(
    (count, key) => count + (livePathKeyOwners.get(key) ?? 0),
    0,
  )
  if (liveOwnerCount !== 1) {
    return null
  }
  return livePathKeyOwners.get(targetPathKey) === 1
}

function sourceRewrite(
  sourcePath: string,
  source: string,
  fromPath: string,
  toPath: string,
  livePathKeyOwners: ReadonlyMap<string, number>,
): string | null {
  const fromKey = notePathKey(fromPath)
  const parsed = parseNote({ path: sourcePath, source })
  const splices: SourceSplice[] = []
  const markdownDestinationSplices = new Map<string, SourceSplice>()
  for (const link of parsed.wikiLinks) {
    const targetPath = wikiNotePath(link.target)
    if (
      targetPath === null ||
      notePathKey(targetPath) !== fromKey ||
      livePathKeyOwners.get(fromKey) !== 1
    ) {
      continue
    }
    const target = wikiTargetAfterMove(link.target, toPath)
    splices.push({
      from: link.from,
      to: link.to,
      text: link.alias === undefined ? `[[${target}]]` : `[[${target}|${link.alias}]]`,
    })
  }

  const markdownSourcePath = sourcePath === fromPath ? toPath : sourcePath
  for (const link of parsed.links) {
    const reference = indexMarkdownNoteReference(sourcePath, link.href)
    if (reference === null || reference.pathKey === null) {
      continue
    }
    const match = markdownReferenceMatchesLiveTarget(
      reference.pathKey,
      reference.alternatePathKey,
      fromKey,
      livePathKeyOwners,
    )
    if (match === null) {
      return null
    }
    if (!match) {
      continue
    }
    if (link.reference?.duplicate === true) {
      return null
    }
    const replacement = markdownHrefAfterMove(link.href, markdownSourcePath, toPath)
    const destination = link.destination
    if (
      destination.from < 0 ||
      destination.to < destination.from ||
      destination.to > source.length
    ) {
      return null
    }
    const spliceKey = `${destination.from}:${destination.to}`
    const existing = markdownDestinationSplices.get(spliceKey)
    if (existing !== undefined && existing.text !== replacement) {
      return null
    }
    if (existing === undefined) {
      markdownDestinationSplices.set(spliceKey, {
        from: destination.from,
        to: destination.to,
        text: replacement,
      })
    }
  }

  splices.push(...markdownDestinationSplices.values())
  return applySourceSplices(source, splices)
}

/**
 * Read and prepare every exact wiki/Markdown path rewrite for a managed note
 * move. The generation-pinned manifest, rather than backlink rows, is the
 * source of candidates: this catches brand-new/unindexed links and every live
 * occurrence. Nothing is written here, and one unreadable live note fails the
 * move closed because its references cannot be ruled out safely.
 */
export async function prepareNoteMoveRewrites(
  options: PrepareNoteMoveRewritesOptions,
): Promise<PreparedNoteMoveRewrites> {
  const livePathKeyOwners = new Map<string, number>()
  for (const path of options.notePaths) {
    const key = notePathKey(path)
    livePathKeyOwners.set(key, (livePathKeyOwners.get(key) ?? 0) + 1)
  }
  const fromPathKey = notePathKey(options.fromPath)
  if (livePathKeyOwners.get(fromPathKey) !== 1) {
    const collidingPaths = [
      ...new Set(options.notePaths.filter((path) => notePathKey(path) === fromPathKey)),
    ].sort((left, right) => left.localeCompare(right))
    return {
      rewrites: [],
      failed: collidingPaths.length > 0 ? collidingPaths : [options.fromPath],
    }
  }
  const rewrites: PreparedNoteMoveRewrite[] = []
  const failed: string[] = []
  for (const path of [...new Set(options.notePaths)].sort((left, right) =>
    left.localeCompare(right),
  )) {
    try {
      const before = await options.read(path)
      const after = sourceRewrite(
        path,
        before,
        options.fromPath,
        options.toPath,
        livePathKeyOwners,
      )
      if (after === null) {
        failed.push(path)
      } else if (after !== before) {
        rewrites.push({ path, before, after })
      }
    } catch {
      failed.push(path)
    }
  }
  return { rewrites, failed }
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

  // Collision guard: if the old title now resolves to a *different* note (a
  // second note owns it as title or alias), the existing links still point
  // somewhere deliberate — rewriting would steal them. A stale index may
  // briefly resolve `from` to the renamed note itself; that's not a collision.
  // Accepted edge: the index lags the watcher debounce, so a note created
  // with the old title inside that sub-second window can be missed here —
  // resolution stays deterministic and the alias still lands, so nothing
  // breaks; the late-created note simply wins future resolutions.
  const resolution = await io.resolve(from)
  if (
    resolution.kind === 'ambiguous' ||
    resolution.kind === 'unavailable' ||
    resolution.kind === 'invalid' ||
    (resolution.kind === 'resolved' && resolution.path !== path)
  ) {
    return { rewritten: [], failed: [], collision: true }
  }

  const sources = await io.sources(foldKey(from))
  const rewritten: string[] = []
  const failed: string[] = []
  let done = 0
  for (const source of sources) {
    try {
      const content = await io.read(source)
      const next = renameWikiLink(content, from, to)
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
