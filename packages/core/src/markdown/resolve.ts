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

import { foldKey } from './keys'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Is `value` a real calendar day (not just `YYYY-MM-DD`-shaped)? Callers gate on
 * {@link ISO_DATE_RE} first, so the split always yields three numeric parts.
 */
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  if (month < 1 || month > 12) {
    return false
  }
  // Day 0 of the next month = the last day of `month` (leap-years included).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day >= 1 && day <= daysInMonth
}

/** A wiki-link target normalized for matching. */
export interface NormalizedTarget {
  /** Original target, trimmed. */
  raw: string
  /** Case-folded key for case-insensitive title/alias matching. */
  key: string
  /** Set when the target is a **real** `YYYY-MM-DD` daily-note reference. */
  date?: string
}

/**
 * Trim, case-fold, and detect a `YYYY-MM-DD` daily-note target. Detection is
 * calendar-valid, not just shape-valid: an impossible date (`2026-02-31`) must
 * not be offered or resolved as a daily anywhere — the desktop's daily route
 * validates the calendar, so a shape-only match here would diverge (suggested
 * as a daily, but clicking it would create a regular note).
 */
export function normalizeWikiTarget(target: string): NormalizedTarget {
  const raw = target.trim()
  const normalized: NormalizedTarget = { raw, key: foldKey(raw) }
  if (ISO_DATE_RE.test(raw) && isCalendarDate(raw)) {
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

/**
 * Async counterpart of {@link WikiLookup} for lookups that hit the database. The
 * index-backed resolver (Plan 04) queries SQLite over IPC, so its lookups are
 * inherently asynchronous; the resolution rules are otherwise identical.
 */
export interface AsyncWikiLookup {
  byDate(date: string): Promise<string | undefined>
  byTitle(key: string): Promise<string | undefined>
  byAlias(key: string): Promise<string | undefined>
}

/**
 * Resolve a `[[target]]` against an async (DB-backed) lookup, with the same
 * precedence as {@link resolveWikiLink}: explicit daily-date, then title, then
 * alias. The `??` chain short-circuits, so a title hit means the alias lookup is
 * never queried. This keeps the resolution *policy* in one place — the
 * index-backed `resolveWikiTarget` supplies only the data access.
 */
export async function resolveWikiLinkAsync(
  target: string,
  lookup: AsyncWikiLookup,
): Promise<Resolution> {
  const normalized = normalizeWikiTarget(target)
  const ref =
    (normalized.date ? await lookup.byDate(normalized.date) : undefined) ??
    (await lookup.byTitle(normalized.key)) ??
    (await lookup.byAlias(normalized.key))
  return ref ? resolved(ref) : unresolved(normalized.raw)
}
