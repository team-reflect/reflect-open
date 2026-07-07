import type { RetrievalHit } from '../embeddings/retrieve'

/**
 * The AI domain's privacy gate (Plan 10). `private: true` is a hard block:
 * a private note's content must never be sent to an external service.
 *
 * Enforcement is structural, not call-site discipline: provider-bound
 * payloads carry note content only as {@link CloudSafe} values, and the
 * *only* constructors for `CloudSafe` live in this module, where the privacy
 * checks run. An unchecked payload can't be built — adding a new AI tool
 * means minting its content here or it won't typecheck.
 */

declare const cloudSafeBrand: unique symbol

/**
 * Proof that a value passed this module's privacy gate. The brand is
 * compile-time only (it serializes as plain JSON); its job is making
 * "checked for privacy" a type the rest of the AI domain can demand.
 */
export type CloudSafe<T> = T & { readonly [cloudSafeBrand]: true }

/** The one place a `CloudSafe` is born. Private by design. */
function mint<T>(value: T): CloudSafe<T> {
  // The brand has no runtime representation, so this assertion is the
  // entire implementation — the guarantees live in the callers below.
  return value as CloudSafe<T>
}

/** What the cloud guard needs to know about a note. */
export interface CloudSendable {
  /** Graph-relative path (for the error message). */
  path: string
  /** The note's live `private: true` frontmatter flag. */
  isPrivate: boolean
}

/** Thrown when a private note would otherwise reach an external service. */
export class PrivateNoteError extends Error {
  constructor(path: string) {
    super(`"${path}" is marked private and cannot be sent to an external service`)
    this.name = 'PrivateNoteError'
  }
}

/** Type guard for {@link PrivateNoteError} across module boundaries. */
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

/** One search hit as an external service may see it. */
export interface CloudSearchHit {
  path: string
  title: string
  snippet: string
  heading: string | null
}

/**
 * Gate retrieval hits for an outbound payload: private hits are dropped
 * **entirely** — even a bare title is a leak — and the rest are stripped to
 * the cloud-facing fields. Retrieval's own `excludePrivateContent` blanks
 * private snippets upstream; this second, stricter gate is what AI callers
 * must pass hits through, so no caller can forget the drop-titles rule.
 *
 * The index's `isPrivate` flag only prefilters: the index can lag a
 * just-saved `private: true` (the same TOCTOU `cloudSafeNoteContent` guards
 * with its live flag), so every surviving hit is re-checked through
 * `isPrivateLive` against the note on disk. The probe must **fail closed**
 * — a missing or unreadable note counts as private.
 */
export async function cloudSafeSearchHits(
  hits: readonly RetrievalHit[],
  isPrivateLive: (path: string) => Promise<boolean>,
): Promise<CloudSafe<CloudSearchHit>[]> {
  const indexedPublic = hits.filter((hit) => !hit.isPrivate)
  const liveFlags = await Promise.all(indexedPublic.map((hit) => isPrivateLive(hit.path)))
  return indexedPublic
    .filter((_, index) => liveFlags[index] === false)
    .map((hit) =>
      mint({ path: hit.path, title: hit.title, snippet: hit.snippet, heading: hit.heading }),
    )
}

/** One note-listing entry as an external service may see it. */
export interface CloudNoteListing {
  path: string
  title: string
  /** ISO `YYYY-MM-DD` when the note is a daily note, `null` otherwise. */
  dailyDate: string | null
  /** The indexed row preview (may be empty). */
  snippet: string
  /** Last file modification, ISO 8601 UTC. */
  modifiedAt: string
}

/**
 * Gate note-list entries (recents, daily ranges) for an outbound payload.
 * Same contract as {@link cloudSafeSearchHits}: a private entry is dropped
 * **entirely** — even its title or path is a leak — and the index's
 * `isPrivate` flag only prefilters, so every survivor is re-checked through
 * `isPrivateLive` against the note on disk, failing closed.
 */
export async function cloudSafeNoteListings(
  entries: readonly (CloudSendable & Omit<CloudNoteListing, 'path'>)[],
  isPrivateLive: (path: string) => Promise<boolean>,
): Promise<CloudSafe<CloudNoteListing>[]> {
  const indexedPublic = entries.filter((entry) => !entry.isPrivate)
  const liveFlags = await Promise.all(indexedPublic.map((entry) => isPrivateLive(entry.path)))
  return indexedPublic
    .filter((_, index) => liveFlags[index] === false)
    .map((entry) =>
      mint({
        path: entry.path,
        title: entry.title,
        dailyDate: entry.dailyDate,
        snippet: entry.snippet,
        modifiedAt: entry.modifiedAt,
      }),
    )
}

/** The graph-level prompt context as an external service may see it. */
export interface CloudGraphContext {
  /** The graph's display name (its root folder name). */
  graphName: string
  /** Non-daily notes the assistant can list or read. */
  noteCount: number
  /** Days with a daily note. */
  dailyNoteCount: number
  /** ISO date of the first daily note, `null` when there are none. */
  earliestDailyDate: string | null
  /** ISO date of the latest daily note, `null` when there are none. */
  latestDailyDate: string | null
  /** Tag facets, most-used first. */
  tags: { tag: string; count: number }[]
  /** The facet list was capped — more tags exist. */
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

/** A note's content as an external service may see it. */
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

/** One asset's stored description as an external service may see it. */
export interface CloudAssetDescription {
  /** Graph-relative asset path, e.g. `assets/photo.png`. */
  path: string
  /** The description file's markdown body (frontmatter stripped, capped). */
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
 * text is minted. `transformSelection` only accepts the minted value, so an
 * unchecked selection cannot typecheck its way to a provider.
 */
export function cloudSafeSelection(note: CloudSendable, selectedText: string): CloudSafe<string> {
  assertCloudAllowed(note)
  return mint(selectedText)
}
