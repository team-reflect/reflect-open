import { useDeferredValue, useState, type ReactElement } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { aliasHint, displayNoteTitle, foldKey, type MeetingAttendee } from '@reflect/core'
import { getIsComposing } from '@meowdown/core'
import { Input } from '@/components/ui/input.tsx'
import { buildAutocompleteEntries, type AutocompleteEntry } from '@reflect/app'
import { useContactsCanLookup } from '@/hooks/use-contacts-state.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraphInfo } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

const SUGGESTION_LIMIT = 6

interface AttendeeComboboxProps {
  /** The input's id, for the field label's `htmlFor`. */
  id: string
  /** Attendees already chosen — kept out of the suggestion list. */
  attendees: readonly MeetingAttendee[]
  /** Adds one attendee. The caller owns dedup and the chip list. */
  onAdd: (attendee: MeetingAttendee) => void
}

function entryKey(entry: AutocompleteEntry): string {
  return `${entry.kind}:${entryName(entry)}`
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
 */
export function AttendeeCombobox({ id, attendees, onAdd }: AttendeeComboboxProps): ReactElement {
  const graph = useGraphInfo()
  const { meetings } = useCoreServices()
  const contactsInMenu = useContactsCanLookup()

  const [query, setQuery] = useState('')
  const [dismissed, setDismissed] = useState(false)
  const [highlighted, setHighlighted] = useState<AutocompleteEntry | undefined>(undefined)
  const deferredQuery = useDeferredValue(query)
  const searchTerm = deferredQuery.trim()

  const {
    data: fetched,
    isFetching,
    isPlaceholderData,
  } = useQuery({
    queryKey: queryKeys.index.attendeeSuggestions(graph?.root, searchTerm, contactsInMenu),
    queryFn: async () => {
      // A contacts hiccup costs only its own rows, never the note suggestions,
      // and daily notes are left out: both are the service's rules.
      const { suggestions, contacts } = await meetings.attendeeSuggestions(
        searchTerm,
        SUGGESTION_LIMIT,
        contactsInMenu,
      )
      return buildAutocompleteEntries(searchTerm, suggestions, {
        offerCreate: true,
        contacts: contacts.map((contact) => ({
          contact,
          target: contact.fullName,
          ownerPath: null,
        })),
      })
    },
    enabled: graph !== null && searchTerm !== '',
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
  const entriesMatchInput = !isFetching && !isPlaceholderData && searchTerm === query.trim()
  const exactContact = entriesMatchInput
    ? entries.find(
        (entry) => entry.kind === 'contact' && foldKey(entry.contact.fullName) === foldKey(query),
      )
    : undefined

  const select = (entry: AutocompleteEntry): void => {
    onAdd(entryAttendee(entry))
    setQuery('')
  }

  const addTyped = (): void => {
    const name = query.trim()
    if (name === '' || !entriesMatchInput || exactContact !== undefined) {
      return
    }
    onAdd({ name })
    setQuery('')
  }

  return (
    <Autocomplete.Root
      items={entries}
      // The service already ranked and filtered the rows.
      mode="none"
      itemToStringValue={entryName}
      value={query}
      onValueChange={(value, details) => {
        // A picked row is added by its own onClick; the input clears instead of filling.
        if (details.reason !== 'item-press') {
          setQuery(value)
          setDismissed(false)
        }
      }}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setDismissed(true)
        }
      }}
      onItemHighlighted={setHighlighted}
      autoHighlight
    >
      <Autocomplete.Input
        id={id}
        placeholder="Add attendee"
        render={<Input />}
        onBlur={addTyped}
        onKeyDown={(keyEvent) => {
          if (getIsComposing()) {
            // The Enter that commits a composition must not pick the highlighted entry
            // or submit the dialog form.
            if (keyEvent.key === 'Enter') {
              keyEvent.preventDefault()
              keyEvent.preventBaseUIHandler()
            }
            return
          }
          if (keyEvent.key === 'Enter') {
            // Ours alone: preventDefault stops the dialog form submitting, and the
            // Base UI handler would pick a highlighted row that may be stale.
            keyEvent.preventDefault()
            keyEvent.preventBaseUIHandler()
            const entry =
              open &&
              entriesMatchInput &&
              highlighted !== undefined &&
              entries.includes(highlighted)
                ? highlighted
                : undefined
            const selected = entry ?? exactContact
            if (selected !== undefined) {
              select(selected)
            } else {
              addTyped()
            }
          }
        }}
      />
      <Autocomplete.Portal>
        <Autocomplete.Positioner align="start" sideOffset={4} className="isolate z-50">
          <Autocomplete.Popup className="max-h-(--available-height) w-(--anchor-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <Autocomplete.List>
              {(entry: AutocompleteEntry) => {
                const hint = entry.kind === 'suggestion' ? aliasHint(entry.suggestion) : null
                return (
                  <Autocomplete.Item
                    key={entryKey(entry)}
                    value={entry}
                    onClick={() => select(entry)}
                    className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-surface-hover data-highlighted:text-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {entry.kind === 'create'
                        ? `Add “${entry.title}”`
                        : entry.kind === 'suggestion'
                          ? displayNoteTitle(entry.suggestion.target)
                          : entryName(entry)}
                    </span>
                    {entry.kind === 'suggestion' && hint !== null && (
                      <span className="truncate text-xs text-text-muted">
                        {hint} → {displayNoteTitle(entry.suggestion.title)}
                      </span>
                    )}
                    {entry.kind === 'contact' && (
                      <span className="truncate text-xs text-text-muted">
                        {entry.contact.emails[0] ?? entry.contact.phones[0] ?? 'Contact'}
                      </span>
                    )}
                  </Autocomplete.Item>
                )
              }}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  )
}
