import {
  foldFallbackTitleKey,
  foldKey,
  serializeWikiSuggestionAddress,
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

export type AutocompleteEntry<Suggestion extends WikiSuggestion = WikiSuggestion> =
  | { kind: 'suggestion'; suggestion: Suggestion }
  | {
      kind: 'contact'
      contact: ContactMatch
      target: string
      ownerPath: string | null
    }
  | { kind: 'create'; title: string }

export interface ContactEntryCandidate {
  readonly contact: ContactMatch
  /** Validated text inserted by a wikilink consumer, or the attendee name. */
  readonly target: string
  /** Existing owner path, or null for a Contact that would create a note. */
  readonly ownerPath: string | null
}

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
  contacts?: readonly ContactEntryCandidate[]
  /** Exact Contact names whose identity is blocked and must not offer Create. */
  blockedContactNames?: readonly string[]
  /**
   * Drop raw Create/contact text that cannot be embedded in `[[…]]` without
   * changing what Markdown parses. False for non-markdown consumers such as
   * the attendee combobox.
   */
  requireSerializableWikiText?: boolean
  /**
   * The raw query parses as a date phrase ("tomorrow", "next friday").
   * Callers with a date-suggestion context pass this so the Create row stays
   * suppressed even when address verification dropped the generated date row
   * itself (its key can be owned by a non-daily note).
   */
  queryReadsAsDate?: boolean
  /**
   * Folded targets already owned by indexed notes, including claims whose
   * suggestion rows were filtered as ambiguous or unsafe.
   */
  claimedTargetKeys?: readonly string[]
}

export function buildAutocompleteEntries<Suggestion extends WikiSuggestion>(
  query: string,
  suggestions: readonly Suggestion[],
  options: EntryOptions = { offerCreate: true },
): AutocompleteEntry<Suggestion>[] {
  const entries: AutocompleteEntry<Suggestion>[] = suggestions.map((suggestion) => ({
    kind: 'suggestion',
    suggestion,
  }))
  const title = query.trim()
  const key = foldKey(title)
  const claimedTargetKeys = new Set(options.claimedTargetKeys ?? [])

  // Exact folding matches ordinary link resolution. The fallback set also
  // prevents a contact action from creating through the same leading-emoji
  // collision this menu protects for bare Create rows. It starts from the
  // claimed keys, not only the surviving rows: a claim filtered out as
  // ambiguous or unsafe still collides with the writable resolver's fallback
  // matching, so it must keep suppressing Create and contact rows.
  const resolvable = new Set<string>()
  const suggestionPaths = new Set<string>()
  const fallbackResolvable = new Set(
    [...claimedTargetKeys].map(foldFallbackTitleKey),
  )
  for (const suggestion of suggestions) {
    if (suggestion.path !== null) {
      suggestionPaths.add(suggestion.path)
    }
    resolvable.add(foldKey(suggestion.target))
    fallbackResolvable.add(foldFallbackTitleKey(suggestion.target))
    if (suggestion.alias !== null) {
      resolvable.add(foldKey(suggestion.alias))
      fallbackResolvable.add(foldFallbackTitleKey(suggestion.alias))
    }
  }
  const contacts = (options.contacts ?? []).filter((candidate) => {
    const { contact } = candidate
    if (candidate.ownerPath !== null) {
      return !suggestionPaths.has(candidate.ownerPath)
    }
    if (
      claimedTargetKeys.has(foldKey(contact.fullName)) ||
      resolvable.has(foldKey(contact.fullName)) ||
      fallbackResolvable.has(foldFallbackTitleKey(contact.fullName))
    ) {
      return false
    }
    return (
      !options.requireSerializableWikiText ||
      serializeWikiSuggestionAddress(candidate.target, null) !== null
    )
  })
  entries.push(
    ...contacts.map((candidate) => ({
      kind: 'contact' as const,
      ...candidate,
    })),
  )

  if (title === '' || !options.offerCreate) {
    return entries
  }
  // An exact title, alias, or date hit means the link would resolve as typed —
  // nothing to create. (A full `YYYY-MM-DD` query always has its daily
  // suggestion injected by the query layer, so dates never offer a create.)
  const resolvesAsTyped = resolvable.has(key)
  // A query that reads as a date — "3 days ago", "next friday" — means a note
  // with that literal title would be noise. The surviving suggestions alone
  // can't decide this: verification may have dropped the generated date row.
  const hasDateSuggestion =
    options.queryReadsAsDate === true ||
    suggestions.some((suggestion) => suggestion.generated !== undefined)
  // A contact row for the exact typed name IS the create action (prefilled) —
  // a bare Create row beside it would just be the worse duplicate.
  const contactCoversQuery =
    contacts.some(({ contact }) => foldKey(contact.fullName) === key) ||
    (options.blockedContactNames ?? []).some((name) => foldKey(name) === key)
  const canSerializeCreate =
    !options.requireSerializableWikiText ||
    serializeWikiSuggestionAddress(title, null) !== null
  // A leading-emoji/whitespace fallback candidate is either the existing note
  // to reuse or an ambiguity to leave unresolved. Neither case may offer a
  // duplicate-creating row.
  const fallbackKey = foldFallbackTitleKey(title)
  const hasFallbackCollision =
    fallbackKey !== '' && fallbackResolvable.has(fallbackKey)
  if (
    !resolvesAsTyped &&
    !claimedTargetKeys.has(key) &&
    !hasFallbackCollision &&
    !hasDateSuggestion &&
    !contactCoversQuery &&
    canSerializeCreate
  ) {
    entries.push({ kind: 'create', title })
  }
  return entries
}
