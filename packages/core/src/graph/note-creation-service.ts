import type { IdService } from '../ports/id-service.ts'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'
import { slugForTitle } from '../markdown/slug.ts'
import type { NoteFileService } from './note-file-service.ts'
import type {
  ExistingWikiTargetResolution,
  NoteLinkResolverService,
} from './note-link-resolver-service.ts'
import { wikiNoteReference } from './note-reference.ts'
import { isDaily, isTemplatePath, notePath } from './paths.ts'
import type { MaybePromise } from '@reflect/utils'

/**
 * The outcome of resolving an existing wiki target or safely creating it.
 */
export type ResolveOrCreateNoteResult =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'created'; readonly path: string }
  | { readonly kind: 'ambiguous'; readonly paths: readonly string[] }
  | { readonly kind: 'unavailable'; readonly paths: readonly string[] }

/**
 * Note creation with a title-derived filename and a ULID frontmatter `id`
 * (`docs/readable-filenames.md`): regular notes live at `notes/<slug>.md`,
 * with a `-2` suffix on collision, and the `id:` survives the renames that
 * follow title changes.
 */
export interface NoteCreationService {
  /**
   * A fresh frontmatter `id` (lowercase ULID, matching the filename convention).
   */
  newNoteId(): string
  /**
   * The buffer seed for a Cmd-N note (created lazily on the first keystroke):
   * an empty H1 plus a fresh `id:`. The `#` carries no trailing space: that
   * is the serializer's round-trip form, and anything else would classify the
   * seed lossy and open the new note read-only.
   */
  untitledNoteSeed(): string
  /**
   * The birth path for a Cmd-N note: no title exists yet, so the filename is
   * a ULID placeholder that the first settled title replaces with the slug.
   */
  untitledNotePath(): string
  /**
   * Create a note titled `title` at the first free path of its slug family,
   * optionally with a body block under the H1. Returns the new path. The
   * write carries `generation`, so a create racing a graph switch is
   * rejected instead of landing in the wrong graph.
   */
  createNoteWithTitle(title: string, generation: number, body?: string): Promise<string>
  /**
   * Resolve a wiki-link title, creating it only on a genuine `missing`. If
   * the atomic claim loses to a concurrent creator, the winner is resolved
   * before any suffix is tried. `body` seeds only a genuinely new note.
   */
  resolveOrCreateNoteWithTitle(
    title: string,
    generation: number,
    body?: string,
  ): Promise<ResolveOrCreateNoteResult>
}

/**
 * `notes/<26-char Crockford-base32 ULID>.md`, the shape of `untitledNotePath()`.
 */
const ULID_NOTE_PATH_RE = /^notes\/[0-7][0-9a-hjkmnp-tv-z]{25}\.md$/

/**
 * Is `path` a ULID placeholder name: a note born untitled that has not yet
 * shed it for a title slug?
 */
export function isUntitledNotePath(path: string): boolean {
  return ULID_NOTE_PATH_RE.test(path)
}

/**
 * How a note pane may treat a path that is not on disk yet.
 */
export interface DeferredCreationPolicy {
  /**
   * The note may be created on its first edit when the pane asks for lazy creation.
   */
  readonly lazyCreatable: boolean
  /**
   * A lazily created note starts from the untitled seed.
   */
  readonly seedsUntitled: boolean
  /**
   * The note maintains title-addressed links when its title changes.
   */
  readonly trackRenames: boolean
}

/**
 * Only daily paths and untitled ULID paths may be created lazily; every
 * other missing path fails closed. Templates rename through file operations
 * only, because the rename pipeline's slug targets live under `notes/`, and a
 * daily's date is its identity, so neither tracks renames. The untitled seed
 * exists to feed the rename pipeline, so templates and dailies skip it.
 */
export function deferredCreationPolicy(path: string): DeferredCreationPolicy {
  const daily = isDaily(path)
  const template = isTemplatePath(path)
  const lazyCreatable = daily || isUntitledNotePath(path)
  return {
    lazyCreatable,
    seedsUntitled: lazyCreatable && !daily && !template,
    trackRenames: !daily && !template,
  }
}

/**
 * Far beyond any real graph's same-slug population; fail loud instead of spinning.
 */
const MAX_CREATE_ATTEMPTS = 1000

type ExistingTitleResolution = Exclude<ExistingWikiTargetResolution, { kind: 'missing' }>

export interface NoteCreationServiceDeps {
  readonly noteFile: NoteFileService
  readonly noteLinkResolver: NoteLinkResolverService
  readonly id: IdService
}

class NoteCreationServiceImpl implements NoteCreationService {
  readonly #deps: NoteCreationServiceDeps

  constructor(deps: NoteCreationServiceDeps) {
    this.#deps = deps
  }

  newNoteId(): string {
    return this.#deps.id.noteId()
  }

  untitledNoteSeed(): string {
    return upsertFrontmatter('#\n', { id: this.#deps.id.noteId() })
  }

  untitledNotePath(): string {
    return notePath(this.#deps.id.noteId())
  }

  async createNoteWithTitle(title: string, generation: number, body?: string): Promise<string> {
    const claimed = await this.#claimNotePathForSlug<never>(
      slugForTitle(title),
      this.#newNoteSource(title, body),
      generation,
      () => null,
    )
    return claimed.path
  }

  async resolveOrCreateNoteWithTitle(
    title: string,
    generation: number,
    body?: string,
  ): Promise<ResolveOrCreateNoteResult> {
    const { noteLinkResolver } = this.#deps
    const existing = await noteLinkResolver.resolveWikiTarget(title, generation)
    if (existing.kind !== 'missing') {
      return existing
    }

    // A bare name invents a titled note under `notes/`; so does an ambiguous
    // slashed spelling once both of its readings have missed, because the
    // author typed it where a title goes. Only an explicitly rooted path (one
    // exact missing file) and a `#heading` or unsafe target (which name
    // nothing creatable) refuse.
    const reference = wikiNoteReference(title)
    if (reference?.kind !== 'key' && reference?.kind !== 'pathOrKey') {
      return {
        kind: 'unavailable',
        paths: reference?.kind === 'path' ? [reference.path] : [],
      }
    }

    // On a lost claim, re-resolve both projections before considering a
    // suffix: the winner may be the note this link meant.
    return await this.#claimNotePathForSlug<ExistingTitleResolution>(
      slugForTitle(title),
      this.#newNoteSource(title, body),
      generation,
      async () => {
        const collision = await noteLinkResolver.resolveWikiTarget(title, generation)
        return collision.kind === 'missing' ? null : collision
      },
    )
  }

  /**
   * The on-disk source for a brand-new note: `id:` frontmatter + H1 title,
   * plus an optional body block under the title.
   */
  #newNoteSource(title: string, body?: string): string {
    const content = body ? `# ${title.trim()}\n\n${body.trim()}\n` : `# ${title.trim()}\n`
    return upsertFrontmatter(content, { id: this.#deps.id.noteId() })
  }

  /**
   * Claim the first free path in `slug`'s collision family (`slug.md`, then
   * `slug-2.md`, ...) through the atomic no-clobber create. `onCollision`
   * runs after each lost claim; a non-null result short-circuits instead of
   * trying the next suffix.
   */
  async #claimNotePathForSlug<Resolution>(
    slug: string,
    source: string,
    generation: number,
    onCollision: () => MaybePromise<Resolution | null>,
  ): Promise<{ kind: 'created'; path: string } | Resolution> {
    for (let ordinal = 1; ordinal <= MAX_CREATE_ATTEMPTS; ordinal += 1) {
      const path = notePath(ordinal === 1 ? slug : `${slug}-${ordinal}`)
      const outcome = await this.#deps.noteFile.create(path, source, generation)
      if (outcome.kind === 'created') {
        return { kind: 'created', path }
      }
      const resolution = await onCollision()
      if (resolution !== null) {
        return resolution
      }
    }
    throw new Error(
      `no available note path for slug "${slug}" after ${MAX_CREATE_ATTEMPTS} attempts`,
    )
  }
}

export function createNoteCreationService(deps: NoteCreationServiceDeps): NoteCreationService {
  return new NoteCreationServiceImpl(deps)
}
