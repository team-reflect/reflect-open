/**
 * Wiki-link resolution model (Plan 03) — the **rules**, not the data. This layer
 * is pure: the actual title/alias/date lookup is injected (DI per conventions
 * §3) so the index-backed resolver can land in Plan 04/07 without this module
 * depending on the database.
 *
 * Note identity in the first wave is the file path; the lookup returns whatever
 * ref the index uses (a note's `id` when it has one, else its path), so "prefer
 * id when present" is honoured at the lookup layer.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** A wiki-link target normalized for matching. */
export interface NormalizedTarget {
  /** Original target, trimmed. */
  raw: string
  /** Case-folded key for case-insensitive title/alias matching. */
  key: string
  /** Set when the target is a `YYYY-MM-DD` daily-note reference. */
  date?: string
}

/** Trim, case-fold, and detect a `YYYY-MM-DD` daily-note target. */
export function normalizeWikiTarget(target: string): NormalizedTarget {
  const raw = target.trim()
  const normalized: NormalizedTarget = { raw, key: raw.toLowerCase() }
  if (ISO_DATE_RE.test(raw)) {
    normalized.date = raw
  }
  return normalized
}

/** Outcome of resolving a `[[wiki link]]` against the graph. */
export type Resolution =
  | { kind: 'resolved'; ref: string }
  | { kind: 'unresolved'; text: string }

export function resolved(ref: string): Resolution {
  return { kind: 'resolved', ref }
}

export function unresolved(text: string): Resolution {
  return { kind: 'unresolved', text }
}

/**
 * Injected lookup the index (Plan 04) implements. Each returns a note `ref`
 * (id-or-path) or `undefined`. Keys are the case-folded {@link NormalizedTarget.key};
 * `byDate` takes a `YYYY-MM-DD` string.
 */
export interface WikiLookup {
  byDate(date: string): string | undefined
  byTitle(key: string): string | undefined
  byAlias(key: string): string | undefined
}

/**
 * Resolve a `[[target]]` to a note ref, preferring an explicit daily-date, then
 * a title match, then an alias match. Pure — see {@link WikiLookup}.
 */
export function resolveWikiLink(target: string, lookup: WikiLookup): Resolution {
  const normalized = normalizeWikiTarget(target)
  const ref =
    (normalized.date ? lookup.byDate(normalized.date) : undefined) ??
    lookup.byTitle(normalized.key) ??
    lookup.byAlias(normalized.key)
  return ref ? resolved(ref) : unresolved(normalized.raw)
}
