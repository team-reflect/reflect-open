import { z } from 'zod'
import { foldKey } from '../markdown/keys'
import { isSafeVisibleGraphPath } from './paths'

/** A note-link target reduced to the keys stored in the derived index. */
export interface IndexedNoteReference {
  /** Title/alias/basename key for a bare wiki target. Empty for exact paths. */
  readonly targetKey: string
  /** Exact graph-relative path candidate, when the syntax names a path. */
  readonly pathKey: string | null
  /** A second exact path candidate for an unqualified Markdown href. */
  readonly alternatePathKey: string | null
  /** Heading fragment without the leading `#`, retained for navigation. */
  readonly fragment: string | null
}

const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const MARKDOWN_EXTENSION_RE = /\.md$/i

interface SplitReference {
  readonly path: string
  readonly fragment: string | null
}

const decodedReferenceComponentSchema = z.string().transform((encoded, context) => {
  try {
    return decodeURIComponent(encoded)
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid percent encoding' })
    return ''
  }
})

const splitReferenceSchema = z.object({
  path: decodedReferenceComponentSchema,
  fragment: z.union([decodedReferenceComponentSchema, z.null()]),
})

function splitReference(value: string): SplitReference | null {
  const hash = value.indexOf('#')
  const rawPath = hash === -1 ? value : value.slice(0, hash)
  const rawFragment = hash === -1 ? null : value.slice(hash + 1)
  const decoded = splitReferenceSchema.safeParse({ path: rawPath, fragment: rawFragment })
  return decoded.success ? decoded.data : null
}

function isHiddenSegment(segment: string): boolean {
  return segment.startsWith('.') && segment !== '.' && segment !== '..'
}

/**
 * Resolve path segments lexically without ever escaping the graph. Hidden
 * components are rejected at this boundary because neither discovery nor an
 * explicit link is allowed to expose them.
 */
function normalizeSegments(path: string, base: readonly string[]): string | null {
  if (path.includes('\\') || path.includes('\0')) {
    return null
  }
  const segments = [...base]
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return null
      }
      segments.pop()
      continue
    }
    if (isHiddenSegment(segment)) {
      return null
    }
    segments.push(segment)
  }
  return segments.length === 0 ? null : segments.join('/')
}

function withMarkdownExtension(path: string): string {
  return MARKDOWN_EXTENSION_RE.test(path) ? path.replace(MARKDOWN_EXTENSION_RE, '.md') : `${path}.md`
}

function hasNonMarkdownExtension(path: string): boolean {
  const filename = path.split('/').pop() ?? path
  const dot = filename.lastIndexOf('.')
  return dot > 0 && !MARKDOWN_EXTENSION_RE.test(filename)
}

function isReservedNotePath(path: string): boolean {
  const first = path.split('/')[0]?.toLowerCase()
  return first === 'assets' || first === 'audio-memos'
}

function pathDirectory(path: string): readonly string[] {
  const segments = path.split('/')
  segments.pop()
  return segments
}

/** Unicode-aware, case-insensitive key for a graph-relative note path. */
export function notePathKey(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

/** Filename stem key used as the final bare-wikilink resolution tier. */
export function noteBasenameKey(path: string): string {
  const filename = path.split('/').pop() ?? path
  return foldKey(filename.replace(MARKDOWN_EXTENSION_RE, '').normalize('NFC'))
}

/** Safe, decoded vault-root path authored by a path-qualified wiki target. */
export function wikiNotePath(target: string): string | null {
  const split = splitReference(target.trim())
  if (split === null) {
    return null
  }
  const authoredPath = split.path.trim()
  if (
    !authoredPath.includes('/') ||
    authoredPath.startsWith('/') ||
    URI_SCHEME_RE.test(authoredPath) ||
    hasNonMarkdownExtension(authoredPath)
  ) {
    return null
  }
  const normalized = normalizeSegments(withMarkdownExtension(authoredPath), [])
  return normalized === null ||
    !isSafeVisibleGraphPath(normalized) ||
    isReservedNotePath(normalized)
    ? null
    : normalized
}

/** Decoded display title of a bare wiki target, excluding `.md` and fragment. */
export function bareWikiTitle(target: string): string | null {
  const split = splitReference(target.trim())
  if (split === null) {
    return null
  }
  const authored = split.path.trim()
  if (authored === '' || authored.includes('/') || authored.includes('\\')) {
    return null
  }
  return authored.replace(MARKDOWN_EXTENSION_RE, '')
}

/**
 * Reduce `[[target]]` to either an exact vault-root path or a bare lookup key.
 * A fragment-only link resolves to the source note. Wiki paths are always
 * vault-root-relative; unlike Markdown hrefs, they never inherit the source
 * note's directory.
 */
export function indexWikiNoteReference(
  sourcePath: string,
  target: string,
): IndexedNoteReference | null {
  const split = splitReference(target.trim())
  if (split === null) {
    return null
  }
  const authoredPath = split.path.trim()
  if (authoredPath === '') {
    if (split.fragment === null) {
      return null
    }
    return {
      targetKey: '',
      pathKey: notePathKey(sourcePath),
      alternatePathKey: null,
      fragment: split.fragment,
    }
  }

  if (authoredPath.includes('/')) {
    const normalized = wikiNotePath(target)
    if (normalized === null) {
      return null
    }
    return {
      targetKey: '',
      pathKey: notePathKey(normalized),
      alternatePathKey: null,
      fragment: split.fragment,
    }
  }

  const title = bareWikiTitle(target)
  if (title === null) {
    return null
  }
  return {
    targetKey: foldKey(title),
    pathKey: null,
    alternatePathKey: null,
    fragment: split.fragment,
  }
}

/**
 * Reduce a standard Markdown note href to exact path candidates.
 *
 * `/x` is vault-root-relative and `./x` / `../x` are source-relative. A plain
 * `x` is intentionally represented by both interpretations when they differ;
 * the resolver may choose the sole existing candidate, but must report
 * ambiguity if both exist.
 */
export function indexMarkdownNoteReference(
  sourcePath: string,
  href: string,
): IndexedNoteReference | null {
  const trimmed = href.trim()
  if (trimmed === '' || URI_SCHEME_RE.test(trimmed) || trimmed.startsWith('//')) {
    return null
  }
  const rawHash = trimmed.indexOf('#')
  const authoredRawPath = rawHash === -1 ? trimmed : trimmed.slice(0, rawHash)
  // Markdown query syntax is not part of a local note path. Check the authored
  // bytes before decoding so `%3F` remains a legitimate literal filename
  // character rather than being mistaken for a query delimiter.
  if (authoredRawPath.includes('?')) {
    return null
  }
  const split = splitReference(trimmed)
  if (split === null) {
    return null
  }
  if (URI_SCHEME_RE.test(split.path) || split.path.startsWith('//')) {
    return null
  }
  if (split.path === '') {
    if (split.fragment === null) {
      return null
    }
    return {
      targetKey: '',
      pathKey: notePathKey(sourcePath),
      alternatePathKey: null,
      fragment: split.fragment,
    }
  }
  const explicitRoot = split.path.startsWith('/')
  const explicitRelative = split.path.startsWith('./') || split.path.startsWith('../')
  const rawPath = explicitRoot ? split.path.slice(1) : split.path
  if (hasNonMarkdownExtension(rawPath)) {
    return null
  }
  const markdownPath = withMarkdownExtension(rawPath)
  const sourceCandidate = normalizeSegments(markdownPath, pathDirectory(sourcePath))
  const rootCandidate = normalizeSegments(markdownPath, [])

  const primary = explicitRoot ? rootCandidate : sourceCandidate
  if (
    primary === null ||
    !isSafeVisibleGraphPath(primary) ||
    isReservedNotePath(primary)
  ) {
    return null
  }
  const alternate =
    explicitRoot ||
    explicitRelative ||
    rootCandidate === null ||
    rootCandidate === primary ||
    !isSafeVisibleGraphPath(rootCandidate) ||
    isReservedNotePath(rootCandidate)
      ? null
      : rootCandidate

  return {
    targetKey: '',
    pathKey: notePathKey(primary),
    alternatePathKey: alternate === null ? null : notePathKey(alternate),
    fragment: split.fragment,
  }
}
