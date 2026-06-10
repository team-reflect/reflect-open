import { foldKey, type WikiSuggestion } from '@reflect/core'

/**
 * Pure assembly of the `[[` popover's rows (Plan 07): the ranked index
 * suggestions, plus a trailing `Create "<query>"` row when nothing matches the
 * typed text exactly. Factored from the component so the offer-create rule is
 * unit-testable (the popover itself needs real custom elements + layout).
 */

export type AutocompleteEntry =
  | { kind: 'suggestion'; suggestion: WikiSuggestion }
  | { kind: 'create'; title: string }

export interface EntryOptions {
  /**
   * Whether a Create row may be offered at all — false while suggestions for
   * the current query are still in flight (the visible list belongs to a
   * previous query, so "nothing matches" can't be concluded yet).
   */
  offerCreate: boolean
}

export function buildAutocompleteEntries(
  query: string,
  suggestions: WikiSuggestion[],
  options: EntryOptions = { offerCreate: true },
): AutocompleteEntry[] {
  const entries: AutocompleteEntry[] = suggestions.map((suggestion) => ({
    kind: 'suggestion',
    suggestion,
  }))
  const title = query.trim()
  if (title === '' || !options.offerCreate) {
    return entries
  }
  const key = foldKey(title)
  // An exact title, alias, or date hit means the link would resolve as typed —
  // nothing to create. (A full `YYYY-MM-DD` query always has its daily
  // suggestion injected by the query layer, so dates never offer a create.)
  const resolvesAsTyped = suggestions.some(
    (suggestion) =>
      foldKey(suggestion.target) === key ||
      (suggestion.alias !== null && foldKey(suggestion.alias) === key),
  )
  if (!resolvesAsTyped) {
    entries.push({ kind: 'create', title })
  }
  return entries
}
