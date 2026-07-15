import { isAssetPath, isSafeVisibleGraphPath } from '../graph/paths'

const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/** Whether a local Markdown destination names a note rather than an attachment. */
export function isMarkdownNoteHref(href: string): boolean {
  const hash = href.indexOf('#')
  const query = href.indexOf('?')
  const end = Math.min(
    hash === -1 ? href.length : hash,
    query === -1 ? href.length : query,
  )
  const rawPath = href.slice(0, end)
  try {
    return /\.md$/i.test(decodeURIComponent(rawPath))
  } catch {
    return false
  }
}

/** Resolve one decoded local href lexically inside the graph. */
function resolveLocalPath(href: string, base: readonly string[]): string | null {
  const hash = href.indexOf('#')
  const query = href.indexOf('?')
  const end = Math.min(hash === -1 ? href.length : hash, query === -1 ? href.length : query)
  const rawPath = href.slice(0, end)
  if (
    rawPath === '' ||
    URI_SCHEME_RE.test(rawPath) ||
    rawPath.startsWith('//') ||
    rawPath.includes('\\') ||
    rawPath.includes('\0')
  ) {
    return null
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (URI_SCHEME_RE.test(decoded)) {
    return null
  }
  const segments = decoded.startsWith('/') ? [] : [...base]
  for (const segment of decoded.replace(/^\/+/, '').split('/')) {
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
    segments.push(segment)
  }
  const path = segments.join('/')
  return isSafeVisibleGraphPath(path) ? path : null
}

function sourceDirectory(path: string): readonly string[] {
  const segments = path.split('/')
  segments.pop()
  return segments
}

/** Resolve a Markdown destination into Reflect's managed attachment tree when possible. */
export function managedAssetPath(
  sourcePath: string,
  href: string,
  allowLegacyRootAssetHref: boolean,
): string | null {
  const relative = resolveLocalPath(href, sourceDirectory(sourcePath))
  if (relative !== null && isAssetPath(relative)) {
    return relative
  }
  let decodedHref: string
  try {
    decodedHref = decodeURIComponent(href)
  } catch {
    return null
  }
  if (
    !allowLegacyRootAssetHref ||
    decodedHref.startsWith('/') ||
    decodedHref.startsWith('./') ||
    decodedHref.startsWith('../')
  ) {
    return null
  }
  const legacyRoot = resolveLocalPath(href, [])
  return legacyRoot !== null && isAssetPath(legacyRoot) ? legacyRoot : null
}

/** Resolve a path-qualified wiki embed from the vault root. */
export function managedWikiEmbedAssetPath(target: string): string | null {
  const path = resolveLocalPath(target, [])
  return path !== null && isAssetPath(path) ? path : null
}

/** Whether a Markdown destination is a syntactically local path candidate. */
export function isAuthoredLocalReference(reference: string): boolean {
  const hash = reference.indexOf('#')
  const query = reference.indexOf('?')
  const end = Math.min(
    hash === -1 ? reference.length : hash,
    query === -1 ? reference.length : query,
  )
  const encodedPath = reference.slice(0, end)
  if (encodedPath === '' || encodedPath.includes('\\') || encodedPath.includes('\0')) {
    return false
  }
  try {
    const decoded = decodeURIComponent(encodedPath)
    return decoded !== '' && !decoded.startsWith('//') && !URI_SCHEME_RE.test(decoded)
  } catch {
    return false
  }
}

/** Canonicalize a safe graph-root href under Reflect's managed `assets/` tree. */
export function canonicalAssetPath(href: string): string | null {
  const path = resolveLocalPath(href, [])
  return path !== null && isAssetPath(path) ? path : null
}
