import { ulid } from 'ulidx'
import { resolveWikiTarget } from '../indexing/queries'
import { foldFallbackTitleKey, foldKey } from '../markdown/keys'
import { parseNote } from '../markdown/extract'
import { upsertFrontmatter } from '../markdown/frontmatter'
import { slugForTitle } from '../markdown/slug'
import { subjectAliases } from '../markdown/subject-aliases'
import { createNoteIfAbsent, listFiles, readNote } from './commands'
import { notePath } from './paths'

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
  const slug = slugForTitle(title)
  const source = newNoteSource(title, body)
  for (let ordinal = 1; ordinal <= MAX_CREATE_ATTEMPTS; ordinal += 1) {
    const path = notePath(ordinal === 1 ? slug : `${slug}-${ordinal}`)
    const outcome = await createNoteIfAbsent(path, source, generation)
    if (outcome.kind === 'created') {
      return path
    }
  }
  throw new Error(`no available note path for slug "${slug}" after ${MAX_CREATE_ATTEMPTS} attempts`)
}

/** Far beyond any real graph's same-slug population; fail loud instead of spinning. */
const MAX_CREATE_ATTEMPTS = 1000

/** The outcome of resolving an existing wiki target or safely creating it. */
export type ResolveOrCreateNoteResult =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'created'; readonly path: string }
  | { readonly kind: 'ambiguous'; readonly paths: readonly string[] }

type ExistingTitleResolution = Exclude<ResolveOrCreateNoteResult, { kind: 'created' }>

interface DiskTitleMatch {
  exactPaths: string[]
  fallbackPaths: string[]
  unreadablePaths: string[]
}

/**
 * Does `path` belong to the collision family for `slug` (`slug.md`,
 * `slug-2.md`, ...)? Limiting the fallback scan to this family keeps the
 * second-chance lookup cheap and avoids turning link navigation into a fuzzy
 * graph-wide title search.
 */
function isSlugFamilyPath(path: string, slug: string): boolean {
  const prefix = 'notes/'
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
  const exactPaths: string[] = []
  const fallbackPaths: string[] = []
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
    const spellings = [
      parsed.title,
      ...parsed.frontmatter.aliases,
      ...subjectAliases(parsed.title),
    ]
    if (spellings.some((spelling) => foldKey(spelling) === targetKey)) {
      exactPaths.push(candidate.path)
      continue
    }
    if (
      fallbackKey !== '' &&
      spellings.some((spelling) => foldFallbackTitleKey(spelling) === fallbackKey)
    ) {
      fallbackPaths.push(candidate.path)
    }
  }

  return { exactPaths, fallbackPaths, unreadablePaths }
}

async function indexedPathForTitle(title: string): Promise<string | null> {
  const resolution = await resolveWikiTarget(title)
  return resolution.kind === 'resolved' ? resolution.ref : null
}

function diskTitleResolution(disk: DiskTitleMatch): ExistingTitleResolution | null {
  if (disk.exactPaths.length === 1) {
    return { kind: 'resolved', path: disk.exactPaths[0]! }
  }
  // Several files claiming the identical title/alias (the historic duplicate
  // bug's own output) is a guess too: sorted-first would even prefer the
  // `-2.md` dupe over the original (`-` sorts before `.`). Refuse, same as an
  // ambiguous fallback.
  if (disk.exactPaths.length > 1) {
    return { kind: 'ambiguous', paths: [...disk.exactPaths].sort() }
  }
  if (disk.unreadablePaths.length > 0 || disk.fallbackPaths.length > 1) {
    return {
      kind: 'ambiguous',
      paths: [...disk.fallbackPaths, ...disk.unreadablePaths].sort(),
    }
  }
  if (disk.fallbackPaths.length === 1) {
    return { kind: 'resolved', path: disk.fallbackPaths[0]! }
  }
  return null
}

/**
 * Resolve a wiki-link title while guarding its title-derived creation path
 * against a stale per-device index.
 *
 * Exact index resolution always wins. On a miss, the title's on-disk slug
 * family is parsed for exact title/alias matches and then for the conservative
 * leading-emoji fallback. Either tier is accepted only when exactly one file
 * claims it; multiple (or unreadable) candidates are ambiguous and no file is
 * written. The index is queried once more immediately before creation. The
 * native path claim is atomic and no-clobber; if it loses to a concurrent sync
 * checkout or creator, the winner is resolved before trying a suffix.
 */
export async function resolveOrCreateNoteWithTitle(
  title: string,
  generation: number,
): Promise<ResolveOrCreateNoteResult> {
  const indexed = await indexedPathForTitle(title)
  if (indexed !== null) {
    return { kind: 'resolved', path: indexed }
  }

  const diskResolution = diskTitleResolution(await matchTitleOnDisk(title, generation))
  if (diskResolution !== null) {
    return diskResolution
  }

  const reResolved = await indexedPathForTitle(title)
  if (reResolved !== null) {
    return { kind: 'resolved', path: reResolved }
  }

  const slug = slugForTitle(title)
  const source = newNoteSource(title)
  for (let ordinal = 1; ordinal <= MAX_CREATE_ATTEMPTS; ordinal += 1) {
    const path = notePath(ordinal === 1 ? slug : `${slug}-${ordinal}`)
    const outcome = await createNoteIfAbsent(path, source, generation)
    if (outcome.kind === 'created') {
      return { kind: 'created', path }
    }

    // The claim lost after our checks. Re-resolve both projections before
    // considering a suffix: the winner may be the note this link meant.
    const collisionIndex = await indexedPathForTitle(title)
    if (collisionIndex !== null) {
      return { kind: 'resolved', path: collisionIndex }
    }
    const collisionDisk = diskTitleResolution(await matchTitleOnDisk(title, generation))
    if (collisionDisk !== null) {
      return collisionDisk
    }
  }
  throw new Error(`no available note path for slug "${slug}" after ${MAX_CREATE_ATTEMPTS} attempts`)
}
