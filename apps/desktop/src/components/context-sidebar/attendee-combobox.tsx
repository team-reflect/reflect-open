import { useDeferredValue, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  contactLinkSuggestions,
  foldKey,
  hasBridge,
  isContactsReadable,
  suggestWikiTargets,
  type MeetingAttendee,
} from '@reflect/core'
import { CommandItem, CommandList } from '@/components/ui/command'
import { INPUT_CLASS_NAME } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  buildAutocompleteEntries,
  type AutocompleteEntry,
} from '@/editor/wiki-autocomplete-entries'
import { useContactsAuthorization } from '@/hooks/use-contacts-authorization'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

const SUGGESTION_LIMIT = 6

interface AttendeeComboboxProps {
  /** Attendees already chosen — kept out of the suggestion list. */
  attendees: readonly MeetingAttendee[]
  /** Adds one attendee. The caller owns dedup and the chip list. */
  onAdd: (attendee: MeetingAttendee) => void
}

/** cmdk item values are matched lowercased, so the key is minted that way. */
function entryKey(entry: AutocompleteEntry): string {
  return `${entry.kind}:${entryName(entry)}`.toLowerCase()
}

/** The attendee name selecting this entry would add. */
function entryName(entry: AutocompleteEntry): string {
  switch (entry.kind) {
    case 'suggestion':
      return entry.suggestion.target
    case 'contact':
      return entry.contact.fullName
    case 'create':
      return entry.title
  }
}

function entryAttendee(entry: AutocompleteEntry): MeetingAttendee {
  // Every Contact email rides along so submit-time ownership cannot give the
  // primary address special treatment.
  return entry.kind === 'contact'
    ? { name: entry.contact.fullName, emails: entry.contact.emails }
    : { name: entryName(entry) }
}

/**
 * The add-meeting dialog's attendee field: a combobox over the same sources
 * as the editor's `[[` menu — ranked note titles, Apple Contacts (when the
 * integration is on and readable), and a trailing `Add "…"` row for names
 * that match nothing. Enter picks the highlighted row, or adds the typed
 * text verbatim when no suggestion is highlighted; Escape dismisses the
 * suggestions without closing the dialog. Daily-note suggestions are
 * filtered out — an attendee is a person, not a date.
 *
 * The input's accessible name comes from cmdk's own `label` mechanism (a
 * visually-hidden `<label>`): cmdk overrides any `id`/`aria-labelledby`
 * passed to its Input, so an external `htmlFor` can never reach it.
 */
export function AttendeeCombobox({ attendees, onAdd }: AttendeeComboboxProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const authorization = useContactsAuthorization()
  const contactsInMenu =
    settings.contactsEnabled && authorization !== null && isContactsReadable(authorization)

  const [query, setQuery] = useState('')
  const [dismissed, setDismissed] = useState(false)
  const [highlighted, setHighlighted] = useState('')
  const deferredQuery = useDeferredValue(query)
  const searchTerm = deferredQuery.trim()

  const { data: fetched, isFetching, isPlaceholderData } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'attendee-suggestions', searchTerm, contactsInMenu],
    queryFn: async () => {
      const [suggestions, contacts] = await Promise.all([
        suggestWikiTargets(searchTerm, SUGGESTION_LIMIT),
        // A contacts hiccup must cost only its own rows, never the note
        // suggestions (the same containment as the editor's `[[` menu).
        contactsInMenu
          ? contactLinkSuggestions(searchTerm).catch((error: unknown) => {
              console.error('contact link suggestions failed:', error)
              return []
            })
          : Promise.resolve([]),
      ])
      return buildAutocompleteEntries(
        searchTerm,
        suggestions.filter((suggestion) => suggestion.date === null),
        {
          offerCreate: true,
          contacts: contacts.map((contact) => ({
            contact,
            target: contact.fullName,
            ownerPath: null,
          })),
        },
      )
    },
    enabled: hasBridge() && graph !== null && searchTerm !== '',
    // Typing re-keys the query as the deferred value settles; holding the
    // previous rows avoids the list flashing closed between keystrokes.
    placeholderData: keepPreviousData,
  })

  const chosen = new Set(attendees.map((attendee) => foldKey(attendee.name)))
  const entries = (searchTerm === '' ? [] : (fetched ?? [])).filter(
    (entry) => !chosen.has(foldKey(entryName(entry))),
  )
  const open = !dismissed && query.trim() !== '' && entries.length > 0
  // The list lags the input twice over (the deferred value, then the fetch —
  // keepPreviousData shows the prior query's rows meanwhile). Enter may only
  // take the highlighted row or add typed text only when the rows answer
  // exactly what is typed. Pending results must not discard Contact emails.
  const entriesMatchInput =
    !isFetching && !isPlaceholderData && searchTerm === query.trim()
  const exactContact = entriesMatchInput
    ? entries.find(
        (entry) =>
          entry.kind === 'contact' &&
          foldKey(entry.contact.fullName) === foldKey(query),
      )
    : undefined

  const select = (entry: AutocompleteEntry): void => {
    onAdd(entryAttendee(entry))
    setQuery('')
    setDismissed(false)
  }

  const addTyped = (): void => {
    const name = query.trim()
    if (name === '' || !entriesMatchInput || exactContact !== undefined) {
      return
    }
    onAdd({ name })
    setQuery('')
    setDismissed(false)
  }

  const onKeyDown = (keyEvent: KeyboardEvent<HTMLInputElement>): void => {
    if (keyEvent.key === 'Enter') {
      // Ours alone: preventDefault stops the dialog form submitting,
      // stopPropagation keeps cmdk's root handler from double-selecting.
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      const entry =
        open && entriesMatchInput
          ? entries.find((candidate) => entryKey(candidate) === highlighted)
          : undefined
      const selected = entry ?? exactContact
      if (selected !== undefined) {
        select(selected)
      } else {
        addTyped()
      }
      return
    }
    if (keyEvent.key === 'Escape' && open) {
      // Dismiss the suggestions only — the dialog must survive this Escape.
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      setDismissed(true)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setDismissed(true)
        }
      }}
    >
      <CommandPrimitive
        label="Attendees"
        shouldFilter={false}
        loop
        value={highlighted}
        onValueChange={setHighlighted}
      >
        <PopoverAnchor asChild>
          <CommandPrimitive.Input
            value={query}
            onValueChange={(value) => {
              setQuery(value)
              setDismissed(false)
            }}
            onKeyDown={onKeyDown}
            onBlur={addTyped}
            placeholder="Add attendee"
            className={INPUT_CLASS_NAME}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-(--radix-popover-trigger-width) p-1"
          // The input keeps focus for the popover's whole life: no focus
          // steal on open/close, and no blur when a row is clicked (blur
          // would add the half-typed text before onSelect adds the row's).
          onOpenAutoFocus={(focusEvent) => focusEvent.preventDefault()}
          onCloseAutoFocus={(focusEvent) => focusEvent.preventDefault()}
          onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
        >
          <CommandList>
            {entries.map((entry) => (
              <CommandItem
                key={entryKey(entry)}
                value={entryKey(entry)}
                onSelect={() => select(entry)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {entry.kind === 'create' ? `Add “${entry.title}”` : entryName(entry)}
                </span>
                {entry.kind === 'suggestion' && entry.suggestion.alias !== null && (
                  <span className="truncate text-xs text-text-muted">
                    {entry.suggestion.alias} → {entry.suggestion.title}
                  </span>
                )}
                {entry.kind === 'contact' && (
                  <span className="truncate text-xs text-text-muted">
                    {entry.contact.emails[0] ?? entry.contact.phones[0] ?? 'Contact'}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </PopoverContent>
      </CommandPrimitive>
    </Popover>
  )
}
