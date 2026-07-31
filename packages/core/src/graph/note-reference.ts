import { foldKey } from '../markdown/keys'
import { isNotePath, isSafeVisibleGraphPath } from './paths'

/**
 * One authored note link reduced to how it must be looked up.
 *
 * `path` names a file, `key` names a note by title / alias / filename stem,
 * and `self` is a bare `#Heading` that never leaves its source note.
 *
 * A `#fragment` is stripped and discarded: it must not reach the lookup (or
 * `[[Plan#Next]]` would search for a note called `Plan#Next`), and Reflect
 * does not navigate to headings. Restoring that feature means returning the
 * stripped value from here, nothing more.
 */
export type NoteReference =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'self' }

const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const MARKDOWN_EXTENSION_RE = /\.md$/i

/**
 * Everything before the first `#`, trimmed. Wiki text is literal: Obsidian
 * never URL-decodes a wiki target, so neither do we. A note titled `100%` is
 * addressable, and `[[A%20B]]` looks for a note called `A%20B`, not `A B`.
 */
function wikiTargetPath(raw: string): string {
  const hash = raw.indexOf('#')
  return (hash === -1 ? raw : raw.slice(0, hash)).trim()
}

/** Everything before the first `#`, percent-decoded; null on a malformed escape. */
function decodedHrefPath(raw: string): string | null {
  const hash = raw.indexOf('#')
  try {
    return decodeURIComponent(hash === -1 ? raw : raw.slice(0, hash)).trim()
  } catch {
    // Refuse rather than resolve a different file than the author wrote.
    return null
  }
}

/**
 * Resolve `authored` against `base` lexically. Returns null when the result
 * escapes the vault, hides behind a dot component, or is not a note path.
 * A target that already carries a non-Markdown extension is an attachment,
 * not a note, so it never grows a `.md` suffix.
 */
function notePathFrom(base: readonly string[], authored: string): string | null {
  if (authored === '' || authored.includes('\\') || authored.includes('\0')) {
    return null
  }
  const filename = authored.split('/').at(-1) ?? authored
  const dot = filename.lastIndexOf('.')
  if (dot > 0 && !MARKDOWN_EXTENSION_RE.test(filename)) {
    return null
  }
  const withExtension = MARKDOWN_EXTENSION_RE.test(authored) ? authored : `${authored}.md`
  const segments = [...base]
  for (const segment of withExtension.split('/')) {
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
  const path = segments.join('/')
  // `isNotePath` also rejects an uppercase `.MD`, matching the discovery
  // policy: a file the walker refuses to list must not be linkable either.
  return isSafeVisibleGraphPath(path) && isNotePath(path) ? path : null
}

function parentSegments(sourcePath: string): readonly string[] {
  const segments = sourcePath.split('/')
  segments.pop()
  return segments
}

/**
 * Reduce `[[target]]`. A path-shaped target is vault-root relative, which is
 * Obsidian's rule and the reason a wiki path never inherits the source note's
 * folder the way a Markdown href does.
 *
 * Path-shaped means every slash segment is non-empty and trim-stable (plus an
 * optional explicit leading `/`). A slash inside loose text stays a name:
 * Reflect's own v1 subject aliases (`[[Tim MacCaw // Dad]]`) are names with a
 * `//` separator, and no filesystem path has components wrapped in spaces.
 */
export function wikiNoteReference(target: string): NoteReference | null {
  const path = wikiTargetPath(target.trim())
  if (path === '') {
    return target.includes('#') ? { kind: 'self' } : null
  }
  if (URI_SCHEME_RE.test(path) || path.includes('\\') || path.includes('\0')) {
    return null
  }
  const rooted = path.startsWith('/')
  const body = rooted ? path.slice(1) : path
  const pathShaped =
    body.includes('/') &&
    body.split('/').every((segment) => segment !== '' && segment === segment.trim())
  if (rooted || pathShaped) {
    const resolved = body === '' ? null : notePathFrom([], body)
    return resolved === null ? null : { kind: 'path', path: resolved }
  }
  const key = foldKey(path.replace(MARKDOWN_EXTENSION_RE, ''))
  return key === '' ? null : { kind: 'key', key }
}

/**
 * Reduce a Markdown href. `/x` is vault-root relative; everything else is
 * source-relative, which is what CommonMark says and what every tool that
 * wrote these files assumed. Reflect has never emitted a Markdown note link,
 * so there is no legacy root-relative spelling to keep working here.
 */
export function markdownNoteReference(sourcePath: string, href: string): NoteReference | null {
  const trimmed = href.trim()
  if (trimmed === '' || URI_SCHEME_RE.test(trimmed) || trimmed.startsWith('//')) {
    return null
  }
  // Check the authored bytes: `%3F` is a legitimate filename character, while
  // a literal `?` opens Markdown query syntax that is not part of the path.
  if ((trimmed.split('#')[0] ?? '').includes('?')) {
    return null
  }
  const path = decodedHrefPath(trimmed)
  if (path === null) {
    return null
  }
  if (path === '') {
    return trimmed.startsWith('#') ? { kind: 'self' } : null
  }
  const rooted = path.startsWith('/')
  const resolved = notePathFrom(
    rooted ? [] : parentSegments(sourcePath),
    rooted ? path.slice(1) : path,
  )
  return resolved === null ? null : { kind: 'path', path: resolved }
}

/** The filename-stem key a note publishes as its weakest address. */
export function noteBasenameKey(path: string): string {
  const filename = path.split('/').at(-1) ?? path
  return foldKey(filename.replace(MARKDOWN_EXTENSION_RE, ''))
}
