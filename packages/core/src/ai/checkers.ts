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
    super(`"${path}" is marked private and cannot be sent to an AI service`)
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
