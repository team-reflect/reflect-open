/**
 * FTS5 query construction (Plan 04).
 *
 * FTS5 interprets a raw `MATCH` argument as query syntax, so operators in user
 * input (`AND`, `OR`, `NOT`, `*`, `(`, `"`) would either change the meaning of
 * the search or raise a syntax error. {@link buildFtsMatch} defends that boundary:
 * it splits the query on whitespace and wraps every term in a double-quoted
 * string (doubling any embedded quote, FTS5's own escape), so each term is
 * matched as a literal — the search is robust to whatever the user types.
 */

import { sql, type RawBuilder } from 'kysely'
import { foldKey } from '../markdown'

/** Split a free-text query into the terms shared by FTS and title recall. */
export function splitSearchTerms(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean)
}

/**
 * Build an FTS5 `MATCH` expression from a free-text query, or `null` when there
 * is nothing to search. FTS5 errors on an empty `MATCH`, so callers should treat
 * `null` as an empty result set rather than passing it to the database.
 */
export function buildFtsMatch(query: string): string | null {
  const terms = splitSearchTerms(query)
  if (terms.length === 0) {
    return null
  }
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' ')
}

/**
 * Scripts written without spaces between words (Han, kana, Hangul, Thai, …).
 * FTS5's `unicode61` tokenizer only segments at non-alphanumeric characters,
 * so a title run in these scripts indexes as ONE token and a shorter query
 * can never match it lexically — such terms need anywhere-in-the-title
 * substring recall. Space-delimited scripts must NOT get it: `car` may find
 * `Car log` but never `Oscar party`. The Rust CLI mirrors this table
 * (`apps/cli/src/keys.rs`); the two must move together.
 */
const UNSEGMENTED_SCRIPT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0e00, 0x0eff], // Thai, Lao
  [0x1000, 0x109f], // Myanmar
  [0x1100, 0x11ff], // Hangul Jamo
  [0x1780, 0x17ff], // Khmer
  [0x3005, 0x3007], // Japanese iteration marks (々〆〇)
  [0x3040, 0x30ff], // Hiragana, Katakana
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0x31f0, 0x31ff], // Katakana Phonetic Extensions
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff66, 0xff9f], // Halfwidth Katakana
  [0x20000, 0x2fa1f], // CJK Extensions B–F, Compatibility Supplement
]

/** True when `value` contains a character from an unsegmented script. */
export function containsUnsegmentedScript(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0
    if (
      UNSEGMENTED_SCRIPT_RANGES.some(
        ([start, end]) => codePoint >= start && codePoint <= end,
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * The `instr` needles for title recall, one per query term, folded like
 * `notes.title_key`. Matched with `instr(' ' || title_key, needle)`: terms in
 * space-delimited scripts carry a leading space so they only match at word
 * starts (`car` finds `Car log`, not `Oscar party`), while unsegmented-script
 * terms match anywhere ({@link containsUnsegmentedScript}) — `unicode61`
 * cannot segment those, so word starts don't exist to anchor on.
 */
export function titleRecallNeedles(query: string): string[] {
  return splitSearchTerms(query)
    .map(foldKey)
    .map((term) => (containsUnsegmentedScript(term) ? term : ` ${term}`))
}

export interface TitleMatchSql {
  /**
   * True when every query term matches the folded title — at a word start for
   * space-delimited scripts, anywhere for unsegmented ones.
   */
  readonly containsAllTerms: RawBuilder<boolean>
  /** Exact (0), whole-query prefix (1), all-terms title match (2), else 3. */
  readonly rank: RawBuilder<number>
}

/**
 * Build title-recall SQL against a stored, already-folded title-key column.
 * Every query term must match per {@link titleRecallNeedles}, so `東京 旅行`
 * matches `東京旅行計画` even though `unicode61` sees the uninterrupted title
 * as one token, while `car` never matches `Oscar party`.
 */
export function buildTitleMatchSql(
  titleKeyColumn: RawBuilder<string>,
  query: string,
): TitleMatchSql {
  const needles = titleRecallNeedles(query)
  const containsAllTerms =
    needles.length === 0
      ? sql<boolean>`0`
      : sql<boolean>`(${sql.join(
          needles.map((needle) => sql`instr(' ' || ${titleKeyColumn}, ${needle}) > 0`),
          sql` and `,
        )})`
  const titleKey = foldKey(query)
  return {
    containsAllTerms,
    rank: sql<number>`case
      when ${titleKeyColumn} = ${titleKey} then 0
      when instr(${titleKeyColumn}, ${titleKey}) = 1 then 1
      when ${containsAllTerms} then 2
      else 3
    end`,
  }
}
