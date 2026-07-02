import { useCallback } from 'react'
import {
  type TagItem,
  type TagSearchHandler,
  type WikilinkItem,
  type WikilinkSearchHandler,
} from '@meowdown/react'
import {
  contactLinkSuggestions,
  createNoteWithTitle,
  hasBridge,
  isContactsReadable,
  suggestTags,
  suggestWikiTargets,
} from '@reflect/core'
import { buildAutocompleteEntries } from '@/editor/wiki-autocomplete-entries'
import { useContactsAuthorization } from '@/hooks/use-contacts-authorization'
import { formatDayLabel, todayIso } from '@/lib/dates'
import { createPersonNoteFromContact } from '@/lib/note-contact'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

/** The `[[` and `#` autocomplete search handlers a {@link NoteEditor} wires up. */
export interface EditorAutocomplete {
  /** Search notes for the `[[` menu: ranked suggestions plus a trailing "Create" row. */
  onWikilinkSearch: WikilinkSearchHandler
  /** Search tags for the `#` menu, most-used first. */
  onTagSearch: TagSearchHandler
}

/**
 * The editor's `[[` and `#` autocomplete, shared by every note editor (the
 * note pane and the Tasks view's inline editor). meowdown owns the menu UI and
 * hands us the raw text typed after `[[` (case preserved, spaces and slashes
 * intact — only `[`, `]`, and newlines close the menu); ranking stays the
 * index's job, so neither menu re-sorts what the host returns. Both handlers
 * are no-ops without a bridge or an open graph.
 *
 * A consumer wires whichever menus it wants — the note pane and the task editor
 * both take `onWikilinkSearch` and `onTagSearch` — so returning both here never
 * forces a menu onto an editor that doesn't pass it through.
 */
export function useEditorAutocomplete(): EditorAutocomplete {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const authorization = useContactsAuthorization()
  const generation = graph?.generation ?? null
  // Contacts join the `[[` menu (v1's backlink-menu behavior) only while the
  // integration is on and the permission readable.
  const contactsInMenu =
    settings.contactsEnabled && authorization !== null && isContactsReadable(authorization)

  // The `[[` autocomplete's create row: make the file; the menu inserts the
  // link text either way (a failed create just leaves an unresolved link).
  const createFromAutocomplete = useCallback(
    async (title: string) => {
      if (generation !== null) {
        await createNoteWithTitle(title, generation)
      }
    },
    [generation],
  )

  const onWikilinkSearch = useCallback(
    async (query: string): Promise<WikilinkItem[]> => {
      if (!hasBridge() || graph === null) {
        return []
      }
      const [suggestions, contacts] = await Promise.all([
        suggestWikiTargets(query, 8, {
          today: todayIso(),
          dateFormat: settings.dateFormat,
          weekStartDay: settings.weekStartDay,
        }),
        // A contacts hiccup (permission revoked mid-session, store error)
        // must cost only its own rows, never the note suggestions.
        contactsInMenu
          ? contactLinkSuggestions(query).catch((error: unknown) => {
              console.error('contact link suggestions failed:', error)
              return []
            })
          : Promise.resolve([]),
      ])
      return buildAutocompleteEntries(query, suggestions, {
        offerCreate: true,
        contacts,
      }).map((entry) => {
        if (entry.kind === 'create') {
          return {
            target: entry.title,
            label: `Create “${entry.title}”`,
            // Insert happens in the menu; create the note in the background.
            // Best-effort: a failed create just leaves an unresolved link.
            onSelect: () => {
              void createFromAutocomplete(entry.title).catch((error: unknown) => {
                console.error('create-from-autocomplete failed:', error)
              })
            },
          }
        }
        if (entry.kind === 'contact') {
          const { contact } = entry
          return {
            target: contact.fullName,
            label: contact.fullName,
            detail: contact.emails[0] ?? contact.phones[0] ?? 'Contact',
            // Like the create row: the menu inserts the link text; the person
            // note is born in the background, prefilled from the contact.
            onSelect: () => {
              if (generation !== null) {
                void createPersonNoteFromContact(contact, generation).catch(
                  (error: unknown) => {
                    console.error('create-person-note failed:', error)
                  },
                )
              }
            },
          }
        }
        const { target, title, alias, date, path, generated } = entry.suggestion
        // A generated date leads with its phrase ("Next Friday"), resolved day
        // as the detail; everything else keeps the title/alias/daily form.
        if (generated !== undefined && date !== null) {
          return { target, label: generated.phrase, detail: formatDayLabel(date, settings.dateFormat) }
        }
        const label = date !== null ? formatDayLabel(date, settings.dateFormat) : title
        const detail =
          alias !== null
            ? `${alias} → ${title}`
            : date !== null
              ? path === null
                ? `${date} · new`
                : date
              : undefined
        return { target, label, ...(detail !== undefined ? { detail } : {}) }
      })
    },
    [
      graph,
      settings.dateFormat,
      settings.weekStartDay,
      createFromAutocomplete,
      contactsInMenu,
      generation,
    ],
  )

  const onTagSearch = useCallback(
    async (query: string): Promise<TagItem[]> => {
      if (!hasBridge() || graph === null) {
        return []
      }
      const tags = await suggestTags(query)
      return tags.map((tag) => ({ tag: tag.tag }))
    },
    [graph],
  )

  return { onWikilinkSearch, onTagSearch }
}
