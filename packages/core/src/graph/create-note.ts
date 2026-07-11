import { ulid } from 'ulidx'
import { findExactWikiTargetMatches } from '../indexing/queries'
import { foldFallbackTitleKey, foldKey } from '../markdown/keys'
import { parseNote } from '../markdown/extract'
import { upsertFrontmatter } from '../markdown/frontmatter'
import { slugForTitle } from '../markdown/slug'
import { subjectAliases } from '../markdown/subject-aliases'
import { createNoteIfAbsent, listFiles, readNote } from './commands'
import { notePath, NOTES_DIR } from './paths'

/**
 * Note identity at creation (`docs/readable-filenames.md`): regular notes get
 * a **title-derived filename** (`notes/<slug>.md`, `-2` suffix on collision)
 * and a frontmatter
 * `id:` ULID — the durable identity Plan 02 specified, which survives the
 * renames that now follow title changes (17b).
 */

/** A fresh frontmatter `id` (lowercase ULID, matching the filename convention). */
export function newNoteId(): string {
  return ulid().toLowerCase()
}

/**
 * The on-disk source for a brand-new note: `id:` frontmatter + H1 title,
 * plus an optional body block under the title (e.g. the add-meeting action's
 * `- Type: #person` line).
 */
export function newNoteSource(title: string, body?: string): string {
  const content = body ? `# ${title.trim()}\n\n${body.trim()}\n` : `# ${title.trim()}\n`
  return upsertFrontmatter(content, { id: newNoteId() })
}

/**
 * The buffer seed for a ⌘N note (created lazily on the first keystroke): an
 * empty H1 — the caret lands in it, the editor ghosts "Untitled" over it
 * (`title-placeholder.ts`), and typing names the note — plus a fresh `id:`.
 * The id rides the seed's header through the session, so it lands on disk
 * with the note's first real save. The `#` carries no trailing space: that
 * is the serializer's round-trip form, and anything else would classify the
 * seed lossy and open the new note read-only.
 */
export function untitledNoteSeed(): string {
  return upsertFrontmatter('#\n', { id: newNoteId() })
}

/**
 * The birth path for a ⌘N note: no title exists yet, so the filename is a
 * ULID placeholder — the first settled title replaces it with the slug
 * (Plan 17's birth rename). The one author of the ULID-path convention.
 */
export function untitledNotePath(): string {
  return notePath(newNoteId())
}

/** `notes/<26-char Crockford-base32 ULID>.md` — {@link untitledNotePath}'s shape. */
const ULID_NOTE_PATH_RE = /^notes\/[0-9a-hjkmnp-tv-z]{26}\.md$/

/**
 * Is `path` a ULID placeholder name — a note born untitled that has not yet
 * shed it for a title slug (Plan 17's birth rename)? The sidebar's "New note"
 * row uses this to show as active while such a note is the current route.
 */
export function isUntitledNotePath(path: string): boolean {
  return ULID_NOTE_PATH_RE.test(path)
}

/**
 * Create a new note titled `title` (Plan 07's create-from-unresolved) at a
 * collision-free slug path, optionally with a body block under the H1.
 * Returns the new graph-relative path. The write carries `generation`, so a
 * create racing a graph switch is rejected loudly instead of landing in the
 * wrong graph.
 */
export async function createNoteWithTitle(
  title: string,
  generation: number,
  body?: string,
): Promise<string> {
  const claimed = await claimNotePathForSlug(slugForTitle(title), newNoteSource(title, body), generation)
  return claimed.path
}

/** Far beyond any real graph's same-slug population; fail loud instead of spinning. */
const MAX_CREATE_ATTEMPTS = 1000

/** The outcome of resolving an existing wiki target or safely creating it. */
export type ResolveOrCreateNoteResult =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'created'; readonly path: string }
  | { readonly kind: 'ambiguous'; readonly paths: readonly string[] }

type ExistingTitleResolution = Exclude<ResolveOrCreateNoteResult, { kind: 'created' }>

/**
 * Claim the first free path in `slug`'s collision family (`slug.md`, then
 * `slug-2.md`, …) through the atomic no-clobber create — the one ordinal
 * convention both create entry points share. `onCollision` runs after each
 * lost claim; a non-null result short-circuits instead of trying the next
 * suffix (`resolveOrCreateNoteWithTitle` re-resolves the winner there).
 */
async function claimNotePathForSlug(
  slug: string,
  source: string,
  generation: number,
): Promise<{ kind: 'created'; path: string }>
async function claimNotePathForSlug(
  slug: string,
  source: string,
  generation: number,
  onCollision: () => Promise<ExistingTitleResolution | null>,
): Promise<ResolveOrCreateNoteResult>
async function claimNotePathForSlug(
  slug: string,
  source: string,
  generation: number,
  onCollision?: () => Promise<ExistingTitleResolution | null>,
): Promise<ResolveOrCreateNoteResult> {
  for (let ordinal = 1; ordinal <= MAX_CREATE_ATTEMPTS; ordinal += 1) {
    const path = notePath(ordinal === 1 ? slug : `${slug}-${ordinal}`)
    const outcome = await createNoteIfAbsent(path, source, generation)
    if (outcome.kind === 'created') {
      return { kind: 'created', path }
    }
    const resolution = (await onCollision?.()) ?? null
    if (resolution !== null) {
      return resolution
    }
  }
  throw new Error(`no available note path for slug "${slug}" after ${MAX_CREATE_ATTEMPTS} attempts`)
}

interface DiskTitleMatch {
  exactTitlePaths: string[]
  exactAliasPaths: string[]
  fallbackTitlePaths: string[]
  fallbackAliasPaths: string[]
  unreadablePaths: string[]
}

/**
 * Does `path` belong to the collision family for `slug` (`slug.md`,
 * `slug-2.md`, ...)? Limiting the fallback scan to this family keeps the
 * second-chance lookup cheap and avoids turning link navigation into a fuzzy
 * graph-wide title search.
 */
function isSlugFamilyPath(path: string, slug: string): boolean {
  // Derived from the same contract `notePath` builds with, so a directory
  // rename can't silently turn the disk guard into an always-empty scan.
  const prefix = `${NOTES_DIR}/`
  const suffix = '.md'
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) {
    return false
  }
  const stem = path.slice(prefix.length, -suffix.length)
  if (stem === slug) {
    return true
  }
  if (!stem.startsWith(`${slug}-`)) {
    return false
  }
  return /^\d+$/.test(stem.slice(slug.length + 1))
}

/**
 * Inspect the title-derived filename family directly on disk. The index can
 * briefly lag a sync checkout; disk is therefore the final authority before a
 * missing-link click is allowed to mint a suffixed note.
 */
async function matchTitleOnDisk(title: string, generation: number): Promise<DiskTitleMatch> {
  const slug = slugForTitle(title)
  const candidates = (await listFiles(generation))
    .filter((file) => isSlugFamilyPath(file.path, slug))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const targetKey = foldKey(title)
  const fallbackKey = foldFallbackTitleKey(title)
  const exactTitlePaths: string[] = []
  const exactAliasPaths: string[] = []
  const fallbackTitlePaths: string[] = []
  const fallbackAliasPaths: string[] = []
  const unreadablePaths: string[] = []

  for (const candidate of candidates) {
    if (candidate.placeholder === true) {
      unreadablePaths.push(candidate.path)
      continue
    }
    let source: string
    try {
      source = await readNote(candidate.path, generation)
    } catch {
      // A disappearing or temporarily unreadable collision cannot be proven
      // distinct. Blocking creation is safer than silently minting `-2`.
      unreadablePaths.push(candidate.path)
      continue
    }
    const parsed = parseNote({ path: candidate.path, source })
    const aliases = [...parsed.frontmatter.aliases, ...subjectAliases(parsed.title)]
    if (foldKey(parsed.title) === targetKey) {
      exactTitlePaths.push(candidate.path)
      continue
    }
    if (aliases.some((alias) => foldKey(alias) === targetKey)) {
      exactAliasPaths.push(candidate.path)
      continue
    }
    if (fallbackKey !== '' && foldFallbackTitleKey(parsed.title) === fallbackKey) {
      fallbackTitlePaths.push(candidate.path)
      continue
    }
    if (
      fallbackKey !== '' &&
      aliases.some((alias) => foldFallbackTitleKey(alias) === fallbackKey)
    ) {
      fallbackAliasPaths.push(candidate.path)
    }
  }

  return {
    exactTitlePaths,
    exactAliasPaths,
    fallbackTitlePaths,
    fallbackAliasPaths,
    unreadablePaths,
  }
}

function resolutionForPaths(paths: readonly string[]): ExistingTitleResolution | null {
  if (paths.length === 1) {
    return { kind: 'resolved', path: paths[0]! }
  }
  if (paths.length > 1) {
    return { kind: 'ambiguous', paths: [...paths].sort() }
  }
  return null
}

async function indexedTargetResolution(
  title: string,
): Promise<ExistingTitleResolution | null> {
  const match = await findExactWikiTargetMatches(title)
  return resolutionForPaths(match.paths)
}

function diskTitleResolution(disk: DiskTitleMatch): ExistingTitleResolution | null {
  // An unreadable candidate could claim any higher-precedence spelling. Do
  // not choose a readable sibling until the whole collision family is known.
  if (disk.unreadablePaths.length > 0) {
    return {
      kind: 'ambiguous',
      paths: [
        ...new Set([
          ...disk.exactTitlePaths,
          ...disk.exactAliasPaths,
          ...disk.fallbackTitlePaths,
          ...disk.fallbackAliasPaths,
          ...disk.unreadablePaths,
        ]),
      ].sort(),
    }
  }

  // Mirror indexed wiki resolution: an exact title outranks an exact alias.
  // Only after both exact tiers miss do the conservative fallback tiers run,
  // again preferring a title to an alias.
  for (const paths of [
    disk.exactTitlePaths,
    disk.exactAliasPaths,
    disk.fallbackTitlePaths,
    disk.fallbackAliasPaths,
  ]) {
    const resolution = resolutionForPaths(paths)
    if (resolution !== null) {
      return resolution
    }
  }
  return null
}

/**
 * Resolve a wiki-link title while guarding its title-derived creation path
 * against a stale per-device index.
 *
 * A unique exact index match wins; multiple indexed claims are ambiguous. On
 * a miss, the title's on-disk slug family is parsed with the same precedence
 * (title before alias), then the conservative leading-emoji fallback. A tier is
 * accepted only when exactly one file claims it; multiple or unreadable
 * candidates are ambiguous and no file is written. The index is queried once
 * more immediately before creation. The native path claim is atomic and
 * no-clobber; if it loses to a concurrent sync checkout or creator, the winner
 * is resolved before trying a suffix.
 */
export async function resolveOrCreateNoteWithTitle(
  title: string,
  generation: number,
): Promise<ResolveOrCreateNoteResult> {
  const indexed = await indexedTargetResolution(title)
  if (indexed !== null) {
    return indexed
  }

  const diskResolution = diskTitleResolution(await matchTitleOnDisk(title, generation))
  if (diskResolution !== null) {
    return diskResolution
  }

  const reResolved = await indexedTargetResolution(title)
  if (reResolved !== null) {
    return reResolved
  }

  // On a lost claim, re-resolve both projections before considering a
  // suffix: the winner may be the note this link meant.
  return claimNotePathForSlug(slugForTitle(title), newNoteSource(title), generation, async () => {
    const collisionIndex = await indexedTargetResolution(title)
    if (collisionIndex !== null) {
      return collisionIndex
    }
    return diskTitleResolution(await matchTitleOnDisk(title, generation))
  })
}
