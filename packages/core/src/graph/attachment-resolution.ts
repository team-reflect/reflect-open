import {
  attachmentReferenceCandidates,
  isAttachmentEmbedTarget,
  wikiEmbedAssetPath,
} from '../markdown/extract.ts'
import type { FileMeta } from './schemas.ts'

/**
 * Display-time attachment resolution: which file an image, link, or
 * Obsidian `![[embed]]` in a note names, answered synchronously from a
 * catalog of the vault's attachment files so an editor can render it.
 *
 * Every answer is one of the spellings the index records for that reference
 * (`parseNote().assets`), so the asset privacy gate always sees the note that
 * displays a file: a candidate path the index stores verbatim, or — only for
 * a bare filename, which the index stores bare and the gate matches by
 * basename — a same-named file found in the catalog.
 */

/** The vault's attachment files, indexed for synchronous lookups. */
export interface AttachmentCatalog {
  /** Does a cataloged attachment live at this graph-relative path? */
  has(path: string): boolean
  /** Size in bytes of the cataloged attachment at this path, if any. */
  size(path: string): number | undefined
  /** Graph-relative paths of every cataloged attachment with this filename. */
  named(filename: string): readonly string[]
}

/** Image formats the editor renders inline; other attachments render as file pills. */
const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])

/** Build a catalog from an attachment listing (`listAttachments`). */
export function createAttachmentCatalog(
  files: readonly Pick<FileMeta, 'path' | 'size'>[],
): AttachmentCatalog {
  const sizes = new Map<string, number>()
  const byName = new Map<string, string[]>()
  for (const { path, size } of files) {
    sizes.set(path, size)
    const name = filename(path)
    const named = byName.get(name)
    if (named === undefined) {
      byName.set(name, [path])
    } else {
      named.push(path)
    }
  }
  return {
    has: (path) => sizes.has(path),
    size: (path) => sizes.get(path),
    named: (name) => byName.get(name) ?? [],
  }
}

/** Does this graph-relative attachment path render as an inline image? */
export function isImageAttachmentPath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot !== -1 && IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

/**
 * The attachment a Markdown link or image destination in `sourcePath` names,
 * or null when the destination is not a local attachment (a URL, a note, a
 * traversal).
 *
 * The first candidate spelling that exists wins (source-relative before
 * vault-root, as CommonMark and Obsidian read it). A bare filename that
 * matches neither falls back to Obsidian's shortest-path rule: a same-named
 * file anywhere in the vault. Otherwise — no catalog yet, or a missing file —
 * the vault-root reading is the answer: that is how Reflect writes `assets/…`
 * links, so its own images render before the catalog loads, and a missing
 * file shows as broken rather than vanishing.
 */
export function resolveAttachmentLink(
  sourcePath: string,
  destination: string,
  catalog: AttachmentCatalog | null,
): string | null {
  const candidates = attachmentReferenceCandidates(sourcePath, destination)
  const fallback = candidates.at(-1)
  if (fallback === undefined) {
    return null
  }
  if (catalog !== null) {
    const existing = candidates.find((path) => catalog.has(path))
    if (existing !== undefined) {
      return existing
    }
    // Only an authored bare filename is Obsidian's shortest-path spelling
    // (`./x`, `/x`, and `../x` each name one place), and only its slash-less
    // candidate is matched by basename in the privacy gate.
    const bare = isBareFilename(destination)
      ? candidates.find((path) => !path.includes('/'))
      : undefined
    const named = bare === undefined ? null : closestNamed(catalog, sourcePath, bare)
    if (named !== null) {
      return named
    }
  }
  return fallback
}

/**
 * What an Obsidian `![[target]]` embed shows: another note (rendered as a
 * link to it, never transcluded), or an attachment as the Markdown destination
 * {@link resolveAttachmentLink} reads it by.
 */
export type WikiEmbedTarget =
  | { readonly kind: 'note' }
  | { readonly kind: 'image' | 'file'; readonly source: string }

/**
 * Classify an Obsidian `![[target]]` embed, or null when it names an
 * attachment at an unsafe path (traversal, hidden components). A target with a
 * folder is vault-root relative; a bare filename is found by name, so the
 * spelling handed out needs no catalog.
 */
export function resolveWikiEmbedTarget(target: string): WikiEmbedTarget | null {
  if (!isAttachmentEmbedTarget(target)) {
    return { kind: 'note' }
  }
  const path = wikiEmbedAssetPath(target)
  if (path === null) {
    return null
  }
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return {
    kind: isImageAttachmentPath(path) ? 'image' : 'file',
    source: path.includes('/') ? `/${encoded}` : encoded,
  }
}

/**
 * The cataloged file named `name` that a link in `sourcePath` most plausibly
 * means when several share the name: one beside the note, else the shallowest,
 * else the first in path order. Any pick is safe for the privacy gate, which
 * matches a bare reference against every same-named file.
 */
function closestNamed(catalog: AttachmentCatalog, sourcePath: string, name: string): string | null {
  const named = catalog.named(name)
  if (named.length <= 1) {
    return named[0] ?? null
  }
  const folder = parentFolder(sourcePath)
  const beside = named.find((path) => parentFolder(path) === folder)
  if (beside !== undefined) {
    return beside
  }
  const [closest] = [...named].sort(
    (left, right) => depth(left) - depth(right) || (left < right ? -1 : left > right ? 1 : 0),
  )
  return closest ?? null
}

function isBareFilename(destination: string): boolean {
  return !(destination.split(/[?#]/, 1)[0] ?? '').includes('/')
}

function filename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function parentFolder(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

function depth(path: string): number {
  return path.split('/').length
}
