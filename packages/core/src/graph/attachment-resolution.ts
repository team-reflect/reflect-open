import { z } from 'zod'
import { fileMetaSchema, type FileMeta } from './schemas'
import { isAttachmentPath, isSafeVisibleGraphPath } from './paths'

/** The authored syntax used to locate a local attachment. */
export const attachmentReferenceKindSchema = z.enum(['markdown', 'wikiEmbed'])

/** The authored syntax used to locate a local attachment. */
export type AttachmentReferenceKind = z.infer<typeof attachmentReferenceKindSchema>

/** The source note and authored path needed to resolve one attachment. */
export const attachmentReferenceSchema = z
  .object({
    sourcePath: z.string().refine((path) => sourceDirectory(path) !== null, {
      message: 'expected a safe graph-relative Markdown source path',
    }),
    reference: z.string().min(1),
    referenceKind: attachmentReferenceKindSchema,
  })
  .strict()

/** The source note and authored path needed to resolve one attachment. */
export type AttachmentReference = z.infer<typeof attachmentReferenceSchema>

/** Generation-pinned request accepted by the native attachment resolver. */
export const attachmentResolveRequestSchema = attachmentReferenceSchema
  .extend({ generation: z.number().int().nonnegative() })
  .strict()

/** Generation-pinned request accepted by the native attachment resolver. */
export type AttachmentResolveRequest = z.infer<typeof attachmentResolveRequestSchema>

/** Whether an attachment can render inline or should open as a file. */
export const attachmentRenderKindSchema = z.enum(['image', 'file'])

/** Whether an attachment can render inline or should open as a file. */
export type AttachmentRenderKind = z.infer<typeof attachmentRenderKindSchema>

/** A visible graph-relative path with a supported attachment extension. */
export const attachmentPathSchema = z.string().refine(isSupportedAttachmentPath, {
  message: 'expected a safe graph-relative attachment path',
})

/** Catalog metadata whose path is eligible for local attachment resolution. */
export const attachmentFileMetaSchema = fileMetaSchema
  .extend({ path: attachmentPathSchema })
  .strict()

/** Catalog metadata for a supported local attachment. */
export type AttachmentFileMeta = z.infer<typeof attachmentFileMetaSchema>

/**
 * Result returned by the native attachment resolver. Missing, unavailable,
 * and ambiguous references remain distinct so callers never guess a path.
 */
export const attachmentResolveOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('resolved'),
      path: attachmentPathSchema,
      renderKind: attachmentRenderKindSchema,
    })
    .strict(),
  z.object({ kind: z.literal('notFound') }).strict(),
  z.object({ kind: z.literal('unavailable'), path: attachmentPathSchema }).strict(),
  z
    .object({ kind: z.literal('ambiguous'), paths: z.array(attachmentPathSchema).min(2) })
    .strict(),
])

/** Validated result returned by the native attachment resolver. */
export type AttachmentResolveOutcome = z.infer<typeof attachmentResolveOutcomeSchema>

/**
 * Side-effect-free catalog resolution adds an explicit invalid result for an
 * authored reference that cannot safely name a graph file. Native resolution
 * reports the same case as an IPC error.
 */
export type AttachmentCatalogResolveOutcome =
  | AttachmentResolveOutcome
  | { readonly kind: 'invalid' }

type CandidatePresence = 'available' | 'unavailable' | 'missing'

interface AttachmentCatalogEntry {
  readonly path: string
  readonly presence: Exclude<CandidatePresence, 'missing'>
}

interface AttachmentCatalogIndex {
  readonly byPath: ReadonlyMap<string, AttachmentCatalogEntry>
  readonly byBasename: ReadonlyMap<string, readonly AttachmentCatalogEntry[]>
  readonly metadataByPath: ReadonlyMap<string, AttachmentFileMeta>
}

/** A catalog indexed once for repeated editor resolution. */
export interface PreparedAttachmentCatalog {
  /** Resolve one authored attachment reference without rebuilding catalog indexes. */
  readonly resolve: (reference: AttachmentReference) => AttachmentCatalogResolveOutcome
  /** Metadata for one canonical graph-relative attachment path. */
  readonly metadataForPath: (path: string) => AttachmentFileMeta | undefined
}

/** Catalog-independent candidates derived from one authored attachment reference. */
export interface AttachmentReferenceCandidates {
  /** Exact graph-relative paths the syntax can mean, in resolution order. */
  readonly exactPaths: readonly string[]
  /** ASCII-case-insensitive filename lookup used only by a bare wiki embed. */
  readonly basename: string | null
}

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

function fileExtension(path: string): string | null {
  const fileName = path.split('/').at(-1)
  if (fileName === undefined) {
    return null
  }
  const separator = fileName.lastIndexOf('.')
  return separator === -1 || separator === fileName.length - 1
    ? null
    : asciiLower(fileName.slice(separator + 1))
}

function isSupportedAttachmentPath(path: string): boolean {
  return isAttachmentPath(path)
}

function decodeReference(reference: string): string | null {
  const hash = reference.indexOf('#')
  const beforeFragment = hash === -1 ? reference : reference.slice(0, hash)
  const query = beforeFragment.indexOf('?')
  const encodedPath = query === -1 ? beforeFragment : beforeFragment.slice(0, query)
  if (encodedPath === '') {
    return null
  }
  try {
    return decodeURIComponent(encodedPath)
  } catch {
    return null
  }
}

function normalizeReference(base: readonly string[], reference: string): string | null {
  if (reference === '' || reference.includes('\\') || reference.includes('\0')) {
    return null
  }
  const components = [...base]
  for (const component of reference.split('/')) {
    if (component === '') {
      return null
    }
    if (component === '.') {
      continue
    }
    if (component === '..') {
      if (components.pop() === undefined) {
        return null
      }
      continue
    }
    if (component.startsWith('.')) {
      return null
    }
    components.push(component)
  }
  const path = components.join('/')
  return isSupportedAttachmentPath(path) ? path : null
}

function explicitVaultReference(reference: string): string | null {
  if (!reference.startsWith('/')) {
    return null
  }
  const relative = reference.slice(1)
  return relative === '' || relative.startsWith('/') ? null : relative
}

function sourceDirectory(sourcePath: string): readonly string[] | null {
  if (!sourcePath.endsWith('.md') || !isSafeVisibleGraphPath(sourcePath)) {
    return null
  }
  const components = sourcePath.split('/')
  components.pop()
  return components
}

function uniquePaths(paths: readonly (string | null)[]): string[] {
  return [...new Set(paths.filter((path): path is string => path !== null))]
}

/**
 * Derive the complete candidate set without consulting the filesystem. The
 * index uses this exact helper to retain conservative privacy candidates, and
 * live resolution then intersects the same candidates with the current
 * generation-scoped attachment catalog.
 */
export function attachmentReferenceCandidates(
  reference: AttachmentReference,
): AttachmentReferenceCandidates | null {
  const parsed = attachmentReferenceSchema.safeParse(reference)
  if (!parsed.success) {
    return null
  }
  const sourceDir = sourceDirectory(parsed.data.sourcePath)
  const decoded = decodeReference(parsed.data.reference)
  if (sourceDir === null || decoded === null || URI_SCHEME_RE.test(decoded)) {
    return null
  }

  if (parsed.data.referenceKind === 'wikiEmbed') {
    if (!decoded.includes('/')) {
      return isAttachmentPath(decoded)
        ? { exactPaths: [], basename: asciiLower(decoded) }
        : null
    }
    const authored = decoded.startsWith('/') ? explicitVaultReference(decoded) : decoded
    const path = authored === null ? null : normalizeReference([], authored)
    return path === null ? null : { exactPaths: [path], basename: null }
  }

  if (decoded.startsWith('/')) {
    const relative = explicitVaultReference(decoded)
    const path = relative === null ? null : normalizeReference([], relative)
    return path === null ? null : { exactPaths: [path], basename: null }
  }
  if (decoded.startsWith('./') || decoded.startsWith('../')) {
    const path = normalizeReference(sourceDir, decoded)
    return path === null ? null : { exactPaths: [path], basename: null }
  }
  const exactPaths = uniquePaths([
    normalizeReference(sourceDir, decoded),
    normalizeReference([], decoded),
  ])
  return exactPaths.length === 0 ? null : { exactPaths, basename: null }
}

function indexCatalog(catalog: readonly FileMeta[]): AttachmentCatalogIndex {
  const byPath = new Map<string, AttachmentCatalogEntry>()
  const metadataByPath = new Map<string, AttachmentFileMeta>()
  for (const file of catalog) {
    if (!isSupportedAttachmentPath(file.path)) {
      continue
    }
    const presence = file.placeholder === true ? 'unavailable' : 'available'
    const existing = byPath.get(file.path)
    if (existing === undefined || presence === 'available') {
      byPath.set(file.path, { path: file.path, presence })
      metadataByPath.set(file.path, file)
    }
  }
  const byBasename = new Map<string, AttachmentCatalogEntry[]>()
  for (const entry of byPath.values()) {
    const basename = asciiLower(entry.path.split('/').at(-1) ?? '')
    const candidates = byBasename.get(basename) ?? []
    candidates.push(entry)
    byBasename.set(basename, candidates)
  }
  return { byPath, byBasename, metadataByPath }
}

function presenceForPath(index: AttachmentCatalogIndex, path: string): CandidatePresence {
  return index.byPath.get(path)?.presence ?? 'missing'
}

/**
 * Classify a supported, visible attachment path for editor rendering. Returns
 * `null` for an unsafe path or unsupported extension so callers cannot turn a
 * forged placeholder path into a renderable resource.
 */
export function attachmentRenderKind(path: string): AttachmentRenderKind | null {
  if (!isSupportedAttachmentPath(path)) {
    return null
  }
  const extension = fileExtension(path)
  return extension !== null && IMAGE_EXTENSIONS.has(extension) ? 'image' : 'file'
}

function outcomeForCandidates(
  candidates: readonly { readonly path: string; readonly presence: CandidatePresence }[],
): AttachmentResolveOutcome {
  const matches = new Map<string, Exclude<CandidatePresence, 'missing'>>()
  for (const candidate of candidates) {
    if (candidate.presence === 'missing') {
      continue
    }
    const existing = matches.get(candidate.path)
    if (existing === undefined || candidate.presence === 'available') {
      matches.set(candidate.path, candidate.presence)
    }
  }
  const paths = [...matches.keys()].sort()
  if (paths.length === 0) {
    return { kind: 'notFound' }
  }
  if (paths.length > 1) {
    return { kind: 'ambiguous', paths }
  }
  const path = paths[0]!
  if (matches.get(path) === 'unavailable') {
    return { kind: 'unavailable', path }
  }
  const renderKind = attachmentRenderKind(path)
  return renderKind === null
    ? { kind: 'notFound' }
    : { kind: 'resolved', path, renderKind }
}

function resolveExactCandidates(
  candidates: AttachmentReferenceCandidates,
  index: AttachmentCatalogIndex,
): AttachmentCatalogResolveOutcome {
  const resolved: { path: string; presence: CandidatePresence }[] = []
  for (const path of candidates.exactPaths) {
    resolved.push({ path, presence: presenceForPath(index, path) })
  }
  return outcomeForCandidates(resolved)
}

function resolveBasenameCandidate(
  basename: string,
  index: AttachmentCatalogIndex,
): AttachmentCatalogResolveOutcome {
  return outcomeForCandidates(
    (index.byBasename.get(basename) ?? []).map((entry) => ({
      path: entry.path,
      presence: entry.presence,
    })),
  )
}

function resolveIndexedAttachment(
  reference: AttachmentReference,
  index: AttachmentCatalogIndex,
): AttachmentCatalogResolveOutcome {
  const candidates = attachmentReferenceCandidates(reference)
  if (candidates === null) {
    return { kind: 'invalid' }
  }
  return candidates.basename === null
    ? resolveExactCandidates(candidates, index)
    : resolveBasenameCandidate(candidates.basename, index)
}

/** Build path and basename indexes once for a generation-scoped manifest. */
export function prepareAttachmentCatalog(
  catalog: readonly FileMeta[],
): PreparedAttachmentCatalog {
  const index = indexCatalog(catalog)
  return {
    resolve: (reference) => resolveIndexedAttachment(reference, index),
    metadataForPath: (path) => index.metadataByPath.get(path),
  }
}

/**
 * Resolve one authored local attachment against a generation-scoped catalog.
 * This is the browser/development counterpart of the native resolver: wiki
 * paths are vault-root relative, Markdown paths honor explicit root/relative
 * syntax, and an unqualified Markdown collision is reported as ambiguous.
 * No filesystem read or creation occurs.
 */
export function resolveAttachmentFromCatalog(
  reference: AttachmentReference,
  catalog: readonly FileMeta[],
): AttachmentCatalogResolveOutcome {
  return prepareAttachmentCatalog(catalog).resolve(reference)
}
