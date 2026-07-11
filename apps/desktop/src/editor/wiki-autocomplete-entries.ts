import {
  foldFallbackTitleKey,
  foldKey,
  type ContactMatch,
  type WikiSuggestion,
} from '@reflect/core'

/**
 * Pure assembly of the `[[` popover's rows (Plan 07): the ranked index
 * suggestions, then Apple Contacts rows (the contacts-integration port —
 * v1 mixed contacts into the backlink menu so a person note could be born
 * from the address book), plus a trailing `Create "<query>"` row when nothing
 * matches the typed text exactly. Factored from the component so the rules
 * are unit-testable (the popover itself needs real custom elements + layout).
 */

export type AutocompleteEntry =
  | { kind: 'suggestion'; suggestion: WikiSuggestion }
  | { kind: 'contact'; contact: ContactMatch }
  | { kind: 'create'; title: string }

export interface EntryOptions {
  /**
   * Whether a Create row may be offered at all — false while suggestions for
   * the current query are still in flight (the visible list belongs to a
   * previous query, so "nothing matches" can't be concluded yet).
   */
  offerCreate: boolean
  /**
   * Apple Contacts matching the query (empty when the integration is off).
   * A contact whose name would resolve to an existing suggestion is dropped —
   * the note row already covers it, exactly v1's dedup.
   */
  contacts?: readonly ContactMatch[]
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

  // Exact folding matches ordinary link resolution. The fallback set also
  // prevents a contact action from creating through the same leading-emoji
  // collision this menu protects for bare Create rows.
  const resolvable = new Set<string>()
  const fallbackResolvable = new Set<string>()
  for (const suggestion of suggestions) {
    resolvable.add(foldKey(suggestion.target))
    fallbackResolvable.add(foldFallbackTitleKey(suggestion.target))
    if (suggestion.alias !== null) {
      resolvable.add(foldKey(suggestion.alias))
      fallbackResolvable.add(foldFallbackTitleKey(suggestion.alias))
    }
  }
  const contacts = (options.contacts ?? []).filter(
    (contact) =>
      !resolvable.has(foldKey(contact.fullName)) &&
      !fallbackResolvable.has(foldFallbackTitleKey(contact.fullName)),
  )
  entries.push(...contacts.map((contact) => ({ kind: 'contact' as const, contact })))

  const title = query.trim()
  if (title === '' || !options.offerCreate) {
    return entries
  }
  const key = foldKey(title)
  // An exact title, alias, or date hit means the link would resolve as typed —
  // nothing to create. (A full `YYYY-MM-DD` query always has its daily
  // suggestion injected by the query layer, so dates never offer a create.)
  const resolvesAsTyped = resolvable.has(key)
  // A leading-emoji/whitespace fallback candidate is either the existing note
  // to reuse or an ambiguity to leave unresolved. Neither case may offer a
  // duplicate-creating row.
  const fallbackKey = foldFallbackTitleKey(title)
  const hasFallbackCollision =
    fallbackKey !== '' && fallbackResolvable.has(fallbackKey)
  // A generated date suggestion means the query reads as a date — "3 days ago",
  // "next friday" — so offering to create a note with that literal title would
  // be noise.
  const hasDateSuggestion = suggestions.some((suggestion) => suggestion.generated !== undefined)
  // A contact row for the exact typed name IS the create action (prefilled) —
  // a bare Create row beside it would just be the worse duplicate.
  const contactCoversQuery = contacts.some((contact) => foldKey(contact.fullName) === key)
  if (!resolvesAsTyped && !hasFallbackCollision && !hasDateSuggestion && !contactCoversQuery) {
    entries.push({ kind: 'create', title })
  }
  return entries
}
