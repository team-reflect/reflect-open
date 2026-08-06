import type { SyntaxNode } from '@meowdown/markdown'
import { dateFromDailyPath, isAttachmentPath, isDaily } from '../graph/paths'
import { parseFrontmatter, splitFrontmatter } from './frontmatter'
import { parseBody } from './grammar'
import { foldTag } from './keys'
import { parseInlineLink } from './link-syntax'
import { headingLevelOf } from './node-types'
import { buildPlainText, plainTextOfRange, unescapeMarkdownText } from './plain-text'
import { normalizeWikiTarget } from './resolve'
import { taskBreadcrumbs } from './task-breadcrumbs'
import { parseTaskMarker } from './task-marker'
import { isWikiNodeName, wikiBracketStart } from './wiki-nodes'
import type {
  AssetRef,
  Frontmatter,
  Heading,
  MarkdownLink,
  ParsedNote,
  ParsedTask,
  Span,
  WikiLink,
} from './model'

/**
 * Extraction (Plan 03): one walk of the Lezer tree derives every entity the
 * indexer (Plan 04) consumes. All positions are mapped back to **original-file**
 * coordinates by adding the frontmatter `bodyOffset`. Pure and unit-tested.
 *
 * Note: `@lezer/markdown` does not emit nodes for plain text — text is the gaps
 * between markup. So plain-text is the body minus the syntax ("*Mark*"/URL)
 * ranges, and tags are scanned from the body while skipping code/URL regions.
 */

// A `#tag`: boundary, a leading letter, then tag chars. Excludes `##`, `#123`, `a#b`.
const TAG_RE = /(^|\s)#(\p{L}[\p{L}\p{N}/_-]*)/gu
// The name grammar alone (no `#`, anchored) — the single source for "could
// this string ever be a tag?" checks (e.g. settings' pinned filter tags).
const TAG_NAME_RE = /^\p{L}[\p{L}\p{N}/_-]*$/u

/**
 * Is `value` a possible tag name (the `#tag` grammar without the `#`)? A name
 * this rejects — spaces, leading digit, empty — can never be produced by the
 * indexer, so a filter built on it would match nothing, forever.
 */
export function isTagName(value: string): boolean {
  return TAG_NAME_RE.test(value)
}

/** Names whose source range is markup to drop from plain text. */
function isSyntaxNode(name: string): boolean {
  return name.endsWith('Mark') || name === 'URL' || name === 'CodeInfo' || name === 'TaskMarker'
}

/** Names whose range should not yield tags (code keeps `#` literal; URLs have `#frag`). */
function isTagExcludedNode(name: string): boolean {
  return (
    name === 'InlineCode' ||
    name === 'FencedCode' ||
    name === 'CodeBlock' ||
    name === 'URL' ||
    isWikiNodeName(name)
  )
}

function isLiteralPlainTextNode(name: string): boolean {
  return name === 'InlineCode' || name === 'FencedCode' || name === 'CodeBlock'
}

function cleanHeadingText(raw: string): string {
  const newline = raw.indexOf('\n')
  if (newline !== -1) {
    return unescapeMarkdownText(raw.slice(0, newline).trim()) // setext: heading text is the first line
  }
  const text = raw
    .replace(/^#{1,6}[ \t]*/, '')
    .replace(/[ \t]*#*[ \t]*$/, '')
    .trim()
  return unescapeMarkdownText(text)
}

/** GitHub-style anchor slug. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, '')
    .replaceAll(/\s+/g, '-')
}

function hostOf(href: string): string | undefined {
  try {
    const url = new URL(href)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.hostname
    }
  } catch {
    // relative or non-URL href — no domain
  }
  return undefined
}

function isAssetHref(href: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) {
    return false // external scheme, protocol-relative, or in-page anchor
  }
  return /(^|\/)assets\//.test(href)
}

/**
 * Every graph-relative path an authored attachment reference can mean, in
 * resolution order.
 *
 * `assets/x.png` is genuinely two things: Reflect has always written it
 * vault-root relative, while CommonMark and Obsidian read it as
 * source-relative. Both spellings are kept so neither an old Reflect note nor
 * an imported vault loses its images. The index stores both, which is inert
 * because only a path that exists on disk is ever consulted.
 *
 * An explicit `/x`, `./x`, or `../x` has one meaning and gets one candidate.
 */
export function attachmentReferenceCandidates(sourcePath: string, reference: string): string[] {
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('//')) {
    return []
  }
  const authored = decodeReferencePath(reference)
  if (authored === '') {
    return []
  }
  if (authored.startsWith('/')) {
    return keepAttachments([resolveSegments([], authored.slice(1))])
  }
  if (authored.startsWith('./') || authored.startsWith('../')) {
    return keepAttachments([resolveSegments(parentSegments(sourcePath), authored)])
  }
  return keepAttachments([
    resolveSegments(parentSegments(sourcePath), authored),
    resolveSegments([], authored),
  ])
}

/** Strip the fragment and query, then percent-decode. */
function decodeReferencePath(reference: string): string {
  const beforeQuery = (reference.split('#')[0] ?? '').split('?')[0] ?? ''
  try {
    return decodeURIComponent(beforeQuery)
  } catch {
    return beforeQuery // a malformed escape keeps the raw spelling, as before
  }
}

function parentSegments(sourcePath: string): readonly string[] {
  const segments = sourcePath.split('/')
  segments.pop()
  return segments
}

function resolveSegments(base: readonly string[], authored: string): string | null {
  if (authored.includes('\\') || authored.includes('\0')) {
    return null
  }
  const segments = [...base]
  for (const segment of authored.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (segments.pop() === undefined) {
        return null
      }
      continue
    }
    if (segment.startsWith('.')) {
      return null
    }
    segments.push(segment)
  }
  return segments.length === 0 ? null : segments.join('/')
}

function keepAttachments(candidates: readonly (string | null)[]): string[] {
  return [
    ...new Set(
      candidates.filter((path): path is string => path !== null && isAttachmentPath(path)),
    ),
  ]
}

/** Does this wiki-embed target name a supported attachment rather than a note? */
function isAttachmentEmbedTarget(target: string): boolean {
  return target !== '' && isAttachmentPath(target.split('/').at(-1) ?? target)
}

/**
 * Wiki embeds are vault-root relative and never URL-decoded (Obsidian's
 * rules). A bare filename stays bare: which folder it lives in is a question
 * only a live catalog can answer, and the privacy gate matches such a
 * reference by basename. A target that resolves to no safe attachment path
 * (traversal, hidden components) returns null — it must never reach the
 * asset projection.
 */
function wikiEmbedAssetPath(target: string): string | null {
  const path = resolveSegments([], target.replace(/^\//, ''))
  return path !== null && isAttachmentPath(path) ? path : null
}

/**
 * Canonicalize an asset href to the on-disk path. A note body may write the same
 * file many ways — percent-encoded (`assets/my%20photo.png`), `./`-prefixed
 * (`./assets/a.png`), with `..`/empty segments — while the file on disk (and the
 * watcher / `dir_list` / `readAsset` paths) is the collapsed `assets/...` form.
 * The index projection and the asset-description privacy gate key off this
 * canonical form, so every spelling of one file collapses to one key — a private
 * referer can't hide behind an alternate encoding *or* an alternate path shape.
 *
 * Decodes percent-escapes (a malformed escape keeps the raw href), then resolves
 * `.`/`..`/empty segments. The `AssetRef` span still points at the raw body text;
 * only the logical `path` is canonicalized.
 */
function decodeAssetPath(href: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(href)
  } catch {
    decoded = href
  }
  const segments: string[] = []
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

/**
 * The canonical on-disk path for an asset href, or `null` when the href is
 * not an asset link at all. The public entry point for callers holding an
 * href copied from raw markdown — e.g. the chat read_assets tool, whose
 * model-supplied paths are the verbatim link targets from note bodies —
 * applying the same {@link decodeAssetPath} rule the index projection uses,
 * so every spelling resolves to the indexed key.
 */
export function canonicalAssetPath(href: string): string | null {
  return isAssetHref(href) ? decodeAssetPath(href) : null
}

function stringField(frontmatter: Frontmatter, key: string): string | undefined {
  const value = (frontmatter as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function basename(path: string): string {
  const file = path.split('/').pop() ?? path
  return file.replace(/\.md$/i, '')
}

function readWikiLink(body: string, from: number, to: number, offset: number): WikiLink {
  const inner = body.slice(from + 2, to - 2)
  const pipe = inner.indexOf('|')
  const target = unescapeMarkdownText((pipe === -1 ? inner : inner.slice(0, pipe)).trim())
  const alias =
    pipe === -1 ? undefined : unescapeMarkdownText(inner.slice(pipe + 1).trim()) || undefined
  return { target, alias, from: from + offset, to: to + offset }
}

function readLink(body: string, from: number, to: number, offset: number): MarkdownLink | null {
  const parsed = parseInlineLink(body.slice(from, to))
  if (!parsed) {
    return null // reference-style or otherwise non-inline link — skipped this wave
  }
  const { href, text } = parsed
  return { href, text, from: from + offset, to: to + offset, domain: hostOf(href) }
}

/**
 * A Reflect task is the round Meowdown checkbox syntax: optional indentation,
 * then `+`, then whitespace, then the GFM marker. Square checklist items
 * (`- [ ]`/`* [ ]`) are intentionally not projected into Tasks.
 */
function hasRoundTaskListMarker(body: string, markerStart: number): boolean {
  const lineStart = body.lastIndexOf('\n', markerStart - 1) + 1
  return /^[\t ]*\+[\t ]+$/.test(body.slice(lineStart, markerStart))
}

function lineEndAfter(body: string, from: number): number {
  const newline = body.indexOf('\n', from)
  return newline === -1 ? body.length : newline
}

/**
 * Resolve a `Task` Lezer node (the marker starts at `from`) into a
 * {@link ParsedTask}, or `null` when the marker shape isn't Reflect's task
 * syntax. `text` is the marker line minus its syntax; `raw` is that physical
 * line verbatim from the marker onward for the write-back guard.
 */
function readTask(
  body: string,
  taskNode: SyntaxNode,
  bodyOffset: number,
  cuts: Span[],
  literalRanges: Span[],
  wikiLinks: WikiLink[],
): ParsedTask | null {
  const { from, to } = taskNode
  if (!hasRoundTaskListMarker(body, from)) {
    return null
  }
  const marker = parseTaskMarker(body.slice(from, from + 3))
  if (marker === null) {
    return null
  }
  const lineEnd = lineEndAfter(body, from)
  const markerOffset = from + bodyOffset
  return {
    text: plainTextOfRange(body, from, lineEnd, cuts, literalRanges),
    breadcrumbs: taskBreadcrumbs(body, taskNode, cuts, literalRanges),
    raw: body.slice(from, lineEnd),
    checked: marker.checked,
    markerOffset,
    dueDate: firstDueDate(wikiLinks, markerOffset, to + bodyOffset),
  }
}

/**
 * The task's due date: the first calendar-valid `[[YYYY-MM-DD]]` link inside the
 * task's span `[from, to)` (file coords). `wikiLinks` are in document order, so
 * "first" is the first such link in the item. Reuses {@link normalizeWikiTarget}
 * so an impossible date (`2026-02-31`) is not treated as a due date — exactly the
 * dailies the resolver recognises.
 */
function firstDueDate(wikiLinks: WikiLink[], from: number, to: number): string | null {
  for (const link of wikiLinks) {
    if (link.from >= from && link.from < to) {
      const { date } = normalizeWikiTarget(link.target)
      if (date !== undefined) {
        return date
      }
    }
  }
  return null
}

function inAnyRange(index: number, ranges: Span[]): boolean {
  return ranges.some((range) => index >= range.from && index < range.to)
}

function collectTags(body: string, excluded: Span[], into: Map<string, string>): void {
  for (const match of body.matchAll(TAG_RE)) {
    // Both groups are mandatory in TAG_RE, so a match always populates them.
    const hashIndex = (match.index ?? 0) + match[1]!.length
    if (inAnyRange(hashIndex, excluded)) {
      continue
    }
    const tag = match[2]!
    const key = foldTag(tag)
    if (!into.has(key)) {
      into.set(key, tag) // dedupe case-insensitively, keep first-seen casing
    }
  }
}

/**
 * The title the note's *content* authors — explicit frontmatter `title:`,
 * else the first non-empty H1 — or `null` when {@link deriveTitle} would fall
 * back to the path (daily date or filename stem). The one definition both
 * derivation and the {@link hasAuthoredTitle} predicate share, so "is this
 * note titled?" can never drift from how the title is actually derived.
 */
function authoredTitle(frontmatter: Frontmatter, headings: Heading[]): string | null {
  const fmTitle = stringField(frontmatter, 'title')
  if (fmTitle && fmTitle.trim()) {
    return fmTitle.trim()
  }
  const h1 = headings.find((heading) => heading.level === 1 && heading.text)
  return h1 ? h1.text : null
}

/**
 * Does the note carry an authored title (frontmatter `title:` or a non-empty
 * H1), rather than falling back to its filename? E.g. the Plan 17c migration
 * skips unauthored ULID notes — there is nothing readable to rename them to.
 */
export function hasAuthoredTitle(note: Pick<ParsedNote, 'frontmatter' | 'headings'>): boolean {
  return authoredTitle(note.frontmatter, note.headings) !== null
}

function deriveTitle(frontmatter: Frontmatter, headings: Heading[], path: string): string {
  const authored = authoredTitle(frontmatter, headings)
  if (authored !== null) {
    return authored
  }
  if (isDaily(path)) {
    const date = dateFromDailyPath(path)
    if (date) {
      return date
    }
  }
  return basename(path)
}

/** Parse one note's full source into the stable {@link ParsedNote} contract. */
export function parseNote(input: { path: string; source: string }): ParsedNote {
  const { path, source } = input
  const { raw, body, bodyOffset } = splitFrontmatter(source)
  const { data: frontmatter, warning } = parseFrontmatter(raw)
  const tree = parseBody(body)

  const wikiLinks: WikiLink[] = []
  const links: MarkdownLink[] = []
  const headings: Heading[] = []
  const assets: AssetRef[] = []
  const cuts: Span[] = [] // body coords — syntax to drop from plain text
  const tagExcluded: Span[] = [] // body coords — regions that don't yield tags
  const literalPlainText: Span[] = [] // body coords — regions that render backslashes literally
  const taskNodes: SyntaxNode[] = [] // body coords — `Task` nodes, resolved after the walk

  tree.iterate({
    enter: (node) => {
      const { name, from, to } = node

      if (isSyntaxNode(name)) {
        cuts.push({ from, to })
      }
      if (name === 'Task') {
        // Resolve after the walk: the child `TaskMarker`/emphasis cuts this task
        // needs to strip its text — and the `[[date]]` due-date link inside it —
        // aren't collected until their own `enter`. The node span bounds the
        // due-date search to this task.
        taskNodes.push(node.node)
      }
      if (isTagExcludedNode(name)) {
        tagExcluded.push({ from, to })
      }
      if (isLiteralPlainTextNode(name)) {
        literalPlainText.push({ from, to })
      }

      if (isWikiNodeName(name)) {
        const wiki = readWikiLink(body, wikiBracketStart(node), to, bodyOffset)
        // `![[photo.png]]` names a file, not a note: it must never become a
        // backlink row or resolve through the note-key tiers. An unsafe
        // target (traversal, hidden components) stays a visible wiki link
        // that resolves to nothing, never an asset row.
        const assetPath =
          name === 'WikiEmbed' && isAttachmentEmbedTarget(wiki.target)
            ? wikiEmbedAssetPath(wiki.target)
            : null
        if (assetPath !== null) {
          assets.push({ path: assetPath, from: wiki.from, to: wiki.to })
        } else {
          wikiLinks.push(wiki)
        }
        return false
      }

      const headingLevel = headingLevelOf(node)
      if (headingLevel !== null) {
        const text = cleanHeadingText(body.slice(from, to))
        // `isTop` is the `Document` node: a heading anywhere else is nested in a
        // blockquote or list item, so it never opens or ends a real section.
        const topLevel = node.node.parent?.type.isTop === true
        headings.push({
          level: headingLevel,
          text,
          slug: slugify(text),
          topLevel,
          from: from + bodyOffset,
          to: to + bodyOffset,
        })
        return true
      }

      if (name === 'Link' || name === 'Image') {
        const link = readLink(body, from, to, bodyOffset)
        if (link) {
          const candidates = attachmentReferenceCandidates(path, link.href)
          if (candidates.length > 0) {
            // One authored reference, several spellings of the same file: the
            // span is shared, and consumers treat `assets` as a path set.
            for (const candidate of candidates) {
              assets.push({ path: candidate, from: link.from, to: link.to })
            }
          } else {
            links.push(link)
          }
        }
        return true
      }

      return true
    },
  })

  const tags = new Map<string, string>()
  collectTags(body, tagExcluded, tags)

  const tasks: ParsedTask[] = []
  for (const taskNode of taskNodes) {
    const task = readTask(body, taskNode, bodyOffset, cuts, literalPlainText, wikiLinks)
    if (task) {
      tasks.push(task)
    }
  }

  return {
    path,
    id: stringField(frontmatter, 'id'),
    title: deriveTitle(frontmatter, headings, path),
    frontmatter,
    frontmatterWarning: warning,
    wikiLinks,
    links,
    tags: [...tags.values()],
    headings,
    assets,
    tasks,
    text: buildPlainText(body, cuts, literalPlainText),
  }
}
