/**
 * Wiki-link resolution model (Plan 03) — the **rules**, not the data. This layer
 * is pure and does not depend on a database.
 */

import { isIsoDate } from '@reflect/utils'
import { foldKey } from './keys.ts'

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
  if (isIsoDate(raw)) {
    normalized.date = raw
  }
  return normalized
}

/** Outcome of resolving a `[[wiki link]]` against the graph. */
export type Resolution = { kind: 'resolved'; ref: string } | { kind: 'unresolved'; text: string }

export function resolved(ref: string): Resolution {
  return { kind: 'resolved', ref }
}

export function unresolved(text: string): Resolution {
  return { kind: 'unresolved', text }
}
