import { indexMarkdownNoteReference, notePathKey, wikiNotePath } from '../graph/local-note-reference'
import { renameWikiLink } from '../markdown/edit'
import { parseNote } from '../markdown/extract'
import { foldKey } from '../markdown/keys'
import { parseInlineLink } from '../markdown/link-syntax'
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

/** One indexed backlink row used to rewrite an exact local-path reference. */
export interface NoteMoveBacklink {
  readonly sourcePath: string
  readonly kind: 'wiki' | 'md'
  readonly targetRaw: string
}

/** A source rewrite prepared before the managed note is moved. */
export interface PreparedNoteMoveRewrite {
  readonly path: string
  readonly before: string
  readonly after: string
}

export interface PrepareNoteMoveRewritesOptions {
  readonly fromPath: string
  readonly toPath: string
  readonly backlinks: readonly NoteMoveBacklink[]
  readonly read: (path: string) => Promise<string>
}

export interface PreparedNoteMoveRewrites {
  readonly rewrites: readonly PreparedNoteMoveRewrite[]
  /** Sources that changed or became unreadable before a safe rewrite could be prepared. */
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
  const keepExtension = /\.md$/i.test(authored.path)
  const rootRelative = authored.path.startsWith('/')
  const target = keepExtension ? toPath : stripMarkdownExtension(toPath)
  const path = rootRelative ? `/${target}` : relativePath(sourcePath, target)
  const explicitSameDirectory = authored.path.startsWith('./') && !path.startsWith('.')
  return `${explicitSameDirectory ? `./${path}` : path}${authored.fragment}`
}

function replaceInlineHref(raw: string, currentHref: string, nextHref: string): string | null {
  const parsed = parseInlineLink(raw)
  if (parsed === null || parsed.href !== currentHref) {
    return null
  }
  const linkStart = raw.indexOf('](')
  if (linkStart === -1) {
    return null
  }
  const bracketed = `<${currentHref}>`
  const bracketedAt = raw.indexOf(bracketed, linkStart + 2)
  if (bracketedAt !== -1) {
    return `${raw.slice(0, bracketedAt + 1)}${nextHref}${raw.slice(bracketedAt + bracketed.length - 1)}`
  }
  const hrefAt = raw.indexOf(currentHref, linkStart + 2)
  return hrefAt === -1
    ? null
    : `${raw.slice(0, hrefAt)}${nextHref}${raw.slice(hrefAt + currentHref.length)}`
}

function referenceCountKey(kind: 'wiki' | 'md', targetRaw: string): string {
  return `${kind}\u0000${targetRaw}`
}

function sourceRewrite(
  sourcePath: string,
  source: string,
  fromPath: string,
  toPath: string,
  backlinks: readonly NoteMoveBacklink[],
): string | null {
  const fromKey = notePathKey(fromPath)
  const expected = new Map<string, number>()
  for (const backlink of backlinks) {
    let exact: boolean
    if (backlink.kind === 'wiki') {
      const path = wikiNotePath(backlink.targetRaw)
      exact = path !== null && notePathKey(path) === fromKey
    } else {
      const reference = indexMarkdownNoteReference(sourcePath, backlink.targetRaw)
      exact =
        reference !== null && [reference.pathKey, reference.alternatePathKey].includes(fromKey)
    }
    if (!exact) {
      continue
    }
    const key = referenceCountKey(backlink.kind, backlink.targetRaw)
    expected.set(key, (expected.get(key) ?? 0) + 1)
  }
  if (expected.size === 0) {
    return source
  }

  const parsed = parseNote({ path: sourcePath, source })
  const splices: SourceSplice[] = []
  for (const link of parsed.wikiLinks) {
    const key = referenceCountKey('wiki', link.target)
    const remaining = expected.get(key) ?? 0
    const targetPath = wikiNotePath(link.target)
    if (remaining === 0 || targetPath === null || notePathKey(targetPath) !== fromKey) {
      continue
    }
    const target = wikiTargetAfterMove(link.target, toPath)
    splices.push({
      from: link.from,
      to: link.to,
      text: link.alias === undefined ? `[[${target}]]` : `[[${target}|${link.alias}]]`,
    })
    expected.set(key, remaining - 1)
  }

  const markdownSourcePath = sourcePath === fromPath ? toPath : sourcePath
  for (const link of parsed.links) {
    const key = referenceCountKey('md', link.href)
    const remaining = expected.get(key) ?? 0
    if (remaining === 0) {
      continue
    }
    const reference = indexMarkdownNoteReference(sourcePath, link.href)
    if (reference === null || ![reference.pathKey, reference.alternatePathKey].includes(fromKey)) {
      continue
    }
    const raw = source.slice(link.from, link.to)
    const replacement = replaceInlineHref(
      raw,
      link.href,
      markdownHrefAfterMove(link.href, markdownSourcePath, toPath),
    )
    if (replacement === null) {
      return null
    }
    splices.push({ from: link.from, to: link.to, text: replacement })
    expected.set(key, remaining - 1)
  }

  return [...expected.values()].some((remaining) => remaining !== 0)
    ? null
    : applySourceSplices(source, splices)
}

/**
 * Read and prepare every exact wiki/Markdown path rewrite for a managed note
 * move. Nothing is written here: the desktop can refuse the move if any source
 * is unreadable or its indexed references no longer match current bytes.
 */
export async function prepareNoteMoveRewrites(
  options: PrepareNoteMoveRewritesOptions,
): Promise<PreparedNoteMoveRewrites> {
  const backlinksBySource = new Map<string, NoteMoveBacklink[]>()
  for (const backlink of options.backlinks) {
    const rows = backlinksBySource.get(backlink.sourcePath) ?? []
    rows.push(backlink)
    backlinksBySource.set(backlink.sourcePath, rows)
  }
  const rewrites: PreparedNoteMoveRewrite[] = []
  const failed: string[] = []
  for (const [path, backlinks] of [...backlinksBySource].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    try {
      const before = await options.read(path)
      const after = sourceRewrite(path, before, options.fromPath, options.toPath, backlinks)
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
  if (resolution.kind === 'resolved' && resolution.ref !== path) {
    return { rewritten: [], failed: [], collision: true }
  }

  const sources = (await io.sources(foldKey(from))).filter((source) => source !== path)
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
