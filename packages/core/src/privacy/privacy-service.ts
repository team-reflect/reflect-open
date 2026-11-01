import type { GraphSessionSource } from '../graph/graph-session.ts'
import type { RetrievalHit } from '../embeddings/retrieval-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { parseFrontmatter, splitFrontmatter } from '../markdown/frontmatter.ts'
import type { CloudSafe } from './cloud-safe.ts'

/**
 * Reflect's outbound-service privacy gate (Plan 10). `private: true` is a hard block:
 * a private note's content must never be sent to an external service.
 *
 * Enforcement is structural, not call-site discipline: provider-bound
 * payloads carry note content only as {@link CloudSafe} values, and the
 * *only* constructors for `CloudSafe` live in this module, where the privacy
 * checks run. An unchecked payload can't be built: adding a new outbound
 * integration means minting its content here or it won't typecheck.
 */

/**
 * The one place a `CloudSafe` is born. Private by design.
 */
function mint<T>(value: T): CloudSafe<T> {
  // The brand has no runtime representation, so this assertion is the
  // entire implementation — the guarantees live in the callers below.
  return value as CloudSafe<T>
}

/**
 * What the cloud guard needs to know about a note.
 */
export interface CloudSendable {
  /**
   * Graph-relative path (for the error message).
   */
  path: string
  /**
   * The note's live `private: true` frontmatter flag.
   */
  isPrivate: boolean
}

/**
 * Thrown when a private note would otherwise reach an external service.
 */
export class PrivateNoteError extends Error {
  constructor(path: string) {
    super(`"${path}" is marked private and cannot be sent to an external service`)
    this.name = 'PrivateNoteError'
  }
}

/**
 * Type guard for {@link PrivateNoteError} across module boundaries.
 */
export function isPrivateNoteError(value: unknown): value is PrivateNoteError {
  return value instanceof Error && value.name === 'PrivateNoteError'
}

/**
 * Assert that `note`'s content may leave the device. Throws
 * {@link PrivateNoteError} when the note is private — callers either let the
 * refusal propagate or turn it into a structured "this note is private"
 * answer, but they can never accidentally ship the body.
 */
export function assertCloudAllowed(note: CloudSendable): void {
  if (note.isPrivate) {
    throw new PrivateNoteError(note.path)
  }
}

/**
 * Gate a link destination before local metadata lookup performs any outbound
 * request on behalf of a note.
 */
export function cloudSafeLinkHref(note: CloudSendable, href: string): CloudSafe<string> {
  assertCloudAllowed(note)
  return mint(href)
}

/**
 * Read a note's authored `private` flag from its full markdown source.
 */
export function notePrivate(source: string): boolean {
  return parseFrontmatter(splitFrontmatter(source).raw).data.private
}

/**
 * One search hit as an external service may see it.
 */
export interface CloudSearchHit {
  path: string
  title: string
  snippet: string
  heading: string | null
}

async function searchHitsWithProbe(
  hits: readonly RetrievalHit[],
  isPrivateLive: (path: string) => Promise<boolean>,
): Promise<CloudSafe<CloudSearchHit>[]> {
  const indexedPublic = hits.filter((hit) => !hit.isPrivate)
  const liveFlags = await Promise.all(indexedPublic.map((hit) => isPrivateLive(hit.path)))
  return indexedPublic
    .filter((_, index) => liveFlags[index] === false)
    .map((hit) => {
      return mint({ path: hit.path, title: hit.title, snippet: hit.snippet, heading: hit.heading })
    })
}

/**
 * One note-listing entry as an external service may see it.
 */
export interface CloudNoteListing {
  path: string
  title: string
  /**
   * ISO `YYYY-MM-DD` when the note is a daily note, `null` otherwise.
   */
  dailyDate: string | null
  /**
   * The indexed row preview (may be empty).
   */
  snippet: string
  /**
   * Last file modification, ISO 8601 UTC.
   */
  modifiedAt: string
}

async function noteListingsWithProbe(
  entries: readonly (CloudSendable & Omit<CloudNoteListing, 'path'>)[],
  isPrivateLive: (path: string) => Promise<boolean>,
): Promise<CloudSafe<CloudNoteListing>[]> {
  const indexedPublic = entries.filter((entry) => !entry.isPrivate)
  const liveFlags = await Promise.all(indexedPublic.map((entry) => isPrivateLive(entry.path)))
  return indexedPublic
    .filter((_, index) => liveFlags[index] === false)
    .map((entry) => {
      return mint({
        path: entry.path,
        title: entry.title,
        dailyDate: entry.dailyDate,
        snippet: entry.snippet,
        modifiedAt: entry.modifiedAt,
      })
    })
}

/**
 * The graph-level prompt context as an external service may see it.
 */
export interface CloudGraphContext {
  /**
   * The graph's display name (its root folder name).
   */
  graphName: string
  /**
   * Non-daily notes the assistant can list or read.
   */
  noteCount: number
  /**
   * Days with a daily note.
   */
  dailyNoteCount: number
  /**
   * ISO date of the first daily note, `null` when there are none.
   */
  earliestDailyDate: string | null
  /**
   * ISO date of the latest daily note, `null` when there are none.
   */
  latestDailyDate: string | null
  /**
   * Tag facets, most-used first.
   */
  tags: { tag: string; count: number }[]
  /**
   * The facet list was capped — more tags exist.
   */
  tagsTruncated: boolean
}

/**
 * Gate the graph-level stats block for the system prompt. Unlike the
 * per-note gates there is nothing to re-check live: these are aggregates
 * with no note identity attached, so privacy rests on the **queries** —
 * callers must compute every figure over `is_private = 0` rows only
 * (`loadGraphStats` does). The index-lag window the live probes close
 * elsewhere (a note marked private moments before reindex) is accepted
 * here: no title, path, or content can leak through an aggregate — at
 * worst a tag name that was public seconds earlier is still counted.
 */
export function cloudSafeGraphContext(context: CloudGraphContext): CloudSafe<CloudGraphContext> {
  return mint(context)
}

/**
 * A note's content as an external service may see it.
 */
export interface CloudNoteContent {
  path: string
  title: string
  content: string
  truncated: boolean
}

/**
 * Gate one note's content for an outbound payload. Callers pass the **live**
 * privacy flag (re-read from the file at call time — the index can be stale
 * right after the user marks a note private); a private note throws
 * {@link PrivateNoteError} before any content is minted.
 */
export function cloudSafeNoteContent(
  note: CloudSendable & Omit<CloudNoteContent, 'path'>,
): CloudSafe<CloudNoteContent> {
  assertCloudAllowed(note)
  return mint({
    path: note.path,
    title: note.title,
    content: note.content,
    truncated: note.truncated,
  })
}

/**
 * One asset's stored description as an external service may see it.
 */
export interface CloudAssetDescription {
  /**
   * Graph-relative asset path, e.g. `assets/photo.png`.
   */
  path: string
  /**
   * The description file's markdown body (frontmatter stripped, capped).
   */
  description: string
  truncated: boolean
}

/**
 * Gate one asset's stored description (Plan 20's `<asset>.reflect.md`) for an
 * outbound payload. Callers pass the asset's **live** privacy verdict as
 * `isPrivate` — sendable only when the asset is referenced by ≥1 public note
 * and 0 private notes, decided from each referencing note's markdown at call
 * time (`classifyAssetFromNotes`), because the sidecar on disk can predate a
 * note turning private. A blocked asset throws {@link PrivateNoteError}
 * before any description text is minted.
 */
export function cloudSafeAssetDescription(
  asset: CloudSendable & Omit<CloudAssetDescription, 'path'>,
): CloudSafe<CloudAssetDescription> {
  assertCloudAllowed(asset)
  return mint({
    path: asset.path,
    description: asset.description,
    truncated: asset.truncated,
  })
}

/**
 * Gate a text selection (the AI menu's editor selection) for an outbound
 * payload. The selection is note content, so the same contract as
 * {@link cloudSafeNoteContent} applies: callers pass the source note's **live**
 * privacy flag, and a private note throws {@link PrivateNoteError} before the
 * text is minted. `SelectionTransformService` only renders its prompt from the
 * minted value, so an unchecked selection cannot typecheck its way to a provider.
 */
export function cloudSafeSelection(note: CloudSendable, selectedText: string): CloudSafe<string> {
  assertCloudAllowed(note)
  return mint(selectedText)
}

export interface PrivacyServiceDeps {
  readonly noteFile: NoteFileService
  readonly graphSession: GraphSessionSource
}

/**
 * The `private: true` gate every outbound payload passes through.
 */
export interface PrivacyService {
  /**
   * Throw {@link PrivateNoteError} unless `note`'s content may leave the device.
   */
  assertCloudAllowed(note: CloudSendable): void
  /**
   * Read a note's authored `private` flag from its full markdown source.
   */
  notePrivate(source: string): boolean
  /**
   * Read a note's live `private` flag from disk. Fails closed: a missing or
   * unreadable note counts as private.
   */
  isPrivateLive(path: string): Promise<boolean>
  /**
   * Gate a link destination before metadata lookup fetches it for a note.
   */
  cloudSafeLinkHref(note: CloudSendable, href: string): CloudSafe<string>
  /**
   * Gate retrieval hits for an outbound payload: private hits are dropped
   * **entirely** (even a bare title is a leak) and the rest are stripped to
   * the cloud-facing fields. The index's `isPrivate` flag only prefilters:
   * the index can lag a just-saved `private: true`, so every surviving hit
   * is re-checked against the note on disk, failing closed.
   */
  cloudSafeSearchHits(hits: readonly RetrievalHit[]): Promise<CloudSafe<CloudSearchHit>[]>
  /**
   * Gate note-list entries (recents, daily ranges) for an outbound payload,
   * with the same contract as {@link PrivacyService.cloudSafeSearchHits}.
   */
  cloudSafeNoteListings(
    entries: readonly (CloudSendable & Omit<CloudNoteListing, 'path'>)[],
  ): Promise<CloudSafe<CloudNoteListing>[]>
  /**
   * Gate the graph-level stats block, computed over public rows only.
   */
  cloudSafeGraphContext(context: CloudGraphContext): CloudSafe<CloudGraphContext>
  /**
   * Gate one note's content, given its live privacy flag.
   */
  cloudSafeNoteContent(
    note: CloudSendable & Omit<CloudNoteContent, 'path'>,
  ): CloudSafe<CloudNoteContent>
  /**
   * Gate one asset's stored description, given the asset's live verdict.
   */
  cloudSafeAssetDescription(
    asset: CloudSendable & Omit<CloudAssetDescription, 'path'>,
  ): CloudSafe<CloudAssetDescription>
  /**
   * Gate an editor selection, given its source note's live privacy flag.
   */
  cloudSafeSelection(note: CloudSendable, selectedText: string): CloudSafe<string>
}

class PrivacyServiceImpl implements PrivacyService {
  readonly #deps: PrivacyServiceDeps

  constructor(deps: PrivacyServiceDeps) {
    this.#deps = deps
  }

  assertCloudAllowed(note: CloudSendable): void {
    assertCloudAllowed(note)
  }

  notePrivate(source: string): boolean {
    return notePrivate(source)
  }

  async isPrivateLive(path: string): Promise<boolean> {
    return await this.#isPrivateAt(path, this.#generation())
  }

  cloudSafeLinkHref(note: CloudSendable, href: string): CloudSafe<string> {
    return cloudSafeLinkHref(note, href)
  }

  async cloudSafeSearchHits(hits: readonly RetrievalHit[]): Promise<CloudSafe<CloudSearchHit>[]> {
    const generation = this.#generation()
    return await searchHitsWithProbe(hits, (path) => this.#isPrivateAt(path, generation))
  }

  async cloudSafeNoteListings(
    entries: readonly (CloudSendable & Omit<CloudNoteListing, 'path'>)[],
  ): Promise<CloudSafe<CloudNoteListing>[]> {
    const generation = this.#generation()
    return await noteListingsWithProbe(entries, (path) => this.#isPrivateAt(path, generation))
  }

  cloudSafeGraphContext(context: CloudGraphContext): CloudSafe<CloudGraphContext> {
    return cloudSafeGraphContext(context)
  }

  cloudSafeNoteContent(
    note: CloudSendable & Omit<CloudNoteContent, 'path'>,
  ): CloudSafe<CloudNoteContent> {
    return cloudSafeNoteContent(note)
  }

  cloudSafeAssetDescription(
    asset: CloudSendable & Omit<CloudAssetDescription, 'path'>,
  ): CloudSafe<CloudAssetDescription> {
    return cloudSafeAssetDescription(asset)
  }

  cloudSafeSelection(note: CloudSendable, selectedText: string): CloudSafe<string> {
    return cloudSafeSelection(note, selectedText)
  }

  #generation(): number | null {
    return this.#deps.graphSession.getState().session?.generation ?? null
  }

  async #isPrivateAt(path: string, generation: number | null): Promise<boolean> {
    if (generation === null) {
      return true
    }
    try {
      return notePrivate(await this.#deps.noteFile.read(path, generation))
    } catch {
      return true
    }
  }
}

export function createPrivacyService(deps: PrivacyServiceDeps): PrivacyService {
  return new PrivacyServiceImpl(deps)
}
