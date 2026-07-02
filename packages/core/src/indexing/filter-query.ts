/**
 * The palette's filter grammar (Plan 08b): typed tokens parsed out of the
 * search query, leaving free text for FTS. Pure — the same parser serves the
 * palette now and the CLI's `search` later (Plan 14).
 *
 * Tokens (everything else is search text):
 * - `#tag`              — note carries the tag (repeatable, ANDed)
 * - `is:daily`          — daily notes only
 * - `is:pinned`         — pinned notes only
 * - `links:Target`      — notes that link **to** Target (quote multi-word:
 *                         `links:"Project X"`)
 * - `linked-from:Target`— notes Target links to
 * - `updated:>D`        — updated on or after `D` (`YYYY-MM-DD`, local)
 * - `updated:<D`        — updated before `D`
 * - `updated:D`         — updated during `D`
 *
 * A malformed token (impossible date, empty value) stays search text — typing
 * never makes results vanish behind a filter the user didn't form yet.
 */
import { isCalendarDate } from '@reflect/utils'
import { foldTag } from '../markdown'

export interface SearchFilters {
  /** Folded tag keys ({@link foldTag} — tags match case-insensitively). */
  tags: string[]
  dailyOnly: boolean
  pinnedOnly: boolean
  /** Title/alias/date of the note results must link to. */
  linksTo: string | null
  /** Title/alias/date of the note results must be linked from. */
  linkedFrom: string | null
  /**
   * Exact path of the note results must link to. Never produced by the parser
   * (there is no token for it) — set by UI pickers that already hold the note,
   * so the filter targets that exact note even when titles are duplicated.
   * When set it takes precedence over {@link linksTo}.
   */
  linksToPath?: string | null
  /**
   * Exact path of the note results must be linked from — the picker-set
   * counterpart of {@link linkedFrom} (see {@link linksToPath}).
   */
  linkedFromPath?: string | null
  /** Inclusive lower bound on `mtime`, epoch ms (local day start). */
  updatedAfterMs: number | null
  /** Exclusive upper bound on `mtime`, epoch ms (local day start). */
  updatedBeforeMs: number | null
}

export interface ParsedSearchQuery {
  /** The free text left for FTS once tokens are removed. */
  text: string
  filters: SearchFilters
  /** True when at least one filter token parsed. */
  filtered: boolean
}

const EMPTY_FILTERS: SearchFilters = {
  tags: [],
  dailyOnly: false,
  pinnedOnly: false,
  linksTo: null,
  linkedFrom: null,
  updatedAfterMs: null,
  updatedBeforeMs: null,
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Mirrors the indexed tag grammar (extract.ts TAG_RE: a leading letter, then
 * letter/number/slash/underscore/dash). A `#` token that couldn't have been
 * indexed (`#123`, `##work`) must stay search text — turning it into a filter
 * would guarantee zero rows for a tag that cannot exist.
 */
const TAG_TOKEN_RE = /^#\p{L}[\p{L}\p{N}/_-]*$/u

/** Epoch ms of the **local** start of `YYYY-MM-DD` (+`days`). */
function localDayStartMs(date: string, days = 0): number {
  // Callers gate on ISO_DATE_RE first, so the split always yields three parts.
  const parts = date.split('-').map(Number)
  const year = parts[0]!
  const month = parts[1]!
  const day = parts[2]!
  return new Date(year, month - 1, day + days).getTime()
}

/** Split on whitespace, keeping `key:"quoted value"` (and bare quotes) whole. */
function tokenize(query: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  for (const char of query) {
    if (char === '"') {
      quoted = !quoted
      current += char
    } else if (!quoted && /\s/.test(char)) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current !== '') {
    tokens.push(current)
  }
  return tokens
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1)
    : value
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const filters: SearchFilters = { ...EMPTY_FILTERS, tags: [] }
  const text: string[] = []
  let filtered = false

  for (const token of tokenize(query)) {
    const lower = token.toLowerCase()

    if (TAG_TOKEN_RE.test(token)) {
      filters.tags.push(foldTag(token.slice(1)))
      filtered = true
      continue
    }
    if (lower === 'is:daily') {
      filters.dailyOnly = true
      filtered = true
      continue
    }
    if (lower === 'is:pinned') {
      filters.pinnedOnly = true
      filtered = true
      continue
    }
    if (lower.startsWith('links:')) {
      const target = unquote(token.slice('links:'.length)).trim()
      if (target !== '') {
        filters.linksTo = target
        filtered = true
        continue
      }
    }
    if (lower.startsWith('linked-from:')) {
      const target = unquote(token.slice('linked-from:'.length)).trim()
      if (target !== '') {
        filters.linkedFrom = target
        filtered = true
        continue
      }
    }
    if (lower.startsWith('updated:')) {
      const value = token.slice('updated:'.length)
      const op = value.startsWith('>') || value.startsWith('<') ? value[0] : null
      const date = op === null ? value : value.slice(1)
      if (ISO_DATE_RE.test(date) && isCalendarDate(date)) {
        if (op === '>') {
          filters.updatedAfterMs = localDayStartMs(date)
        } else if (op === '<') {
          filters.updatedBeforeMs = localDayStartMs(date)
        } else {
          filters.updatedAfterMs = localDayStartMs(date)
          filters.updatedBeforeMs = localDayStartMs(date, 1)
        }
        filtered = true
        continue
      }
    }
    text.push(token)
  }

  return { text: text.join(' '), filters, filtered }
}
