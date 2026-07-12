import { ulid } from 'ulidx'
import { upsertFrontmatter } from '../markdown/frontmatter'
import { slugForTitle } from '../markdown/slug'
import { createNoteIfAbsent } from './commands'
import { notePath } from './paths'
import {
  resolveExistingWikiTarget,
  type ExistingWikiTargetResolution,
} from './resolve-existing-wiki-target'

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
  | { readonly kind: 'unavailable'; readonly paths: readonly string[] }

type ExistingTitleResolution = Exclude<ExistingWikiTargetResolution, { kind: 'missing' }>

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

/**
 * Resolve a wiki-link title while guarding its title-derived creation path
 * against a stale per-device index.
 *
 * Delegates the read-only decision to {@link resolveExistingWikiTarget}, so
 * date/title/alias precedence, ambiguity, unavailable files, the bounded disk
 * fallback, and the final index race check have one implementation. Only a
 * genuine `missing` result reaches the atomic no-clobber claim. If that claim
 * loses to a concurrent sync checkout or creator, the winner is resolved
 * before any suffix is tried.
 */
export async function resolveOrCreateNoteWithTitle(
  title: string,
  generation: number,
): Promise<ResolveOrCreateNoteResult> {
  const existing = await resolveExistingWikiTarget(title, generation)
  if (existing.kind !== 'missing') {
    return existing
  }

  // On a lost claim, re-resolve both projections before considering a
  // suffix: the winner may be the note this link meant.
  return claimNotePathForSlug(slugForTitle(title), newNoteSource(title), generation, async () => {
    const collisionResolution = await resolveExistingWikiTarget(title, generation)
    return collisionResolution.kind === 'missing' ? null : collisionResolution
  })
}
