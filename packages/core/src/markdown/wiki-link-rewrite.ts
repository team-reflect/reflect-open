import { foldKey } from './keys'

/**
 * Rename the path portion of a resolver-supported bare wiki target while
 * preserving its optional Markdown extension and percent-encoded spelling.
 */
export function renamedBareWikiTarget(
  target: string,
  fromKey: string,
  to: string,
): string | null {
  const hash = target.indexOf('#')
  const authoredPath = (hash === -1 ? target : target.slice(0, hash)).trim()
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(authoredPath)
  } catch {
    return null
  }
  if (decodedPath === '' || decodedPath.includes('/') || decodedPath.includes('\\')) {
    return null
  }
  const extension = /\.md$/i.exec(decodedPath)?.[0] ?? ''
  const title = extension === '' ? decodedPath : decodedPath.slice(0, -extension.length)
  if (title === '' || foldKey(title) !== fromKey) {
    return null
  }
  const nextPath = authoredPath !== decodedPath || /[#%]/.test(to)
    ? encodeURIComponent(`${to}${extension}`)
    : `${to}${extension}`
  return nextPath
}
