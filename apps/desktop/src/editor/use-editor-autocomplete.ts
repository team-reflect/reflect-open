import { useCallback } from 'react'
import {
  type TagItem,
  type TagSearchHandler,
  type WikilinkItem,
  type WikilinkSearchHandler,
} from '@meowdown/react'
import { hasBridge, suggestTags, suggestWikiTargets } from '@reflect/core'
import { buildAutocompleteEntries } from '@/editor/wiki-autocomplete-entries'
import { createNoteWithTitle } from '@/lib/create-note'
import { formatDayLabel } from '@/lib/dates'
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
 * hands us the (lowercased, punctuation-stripped) query; ranking stays the
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
  const generation = graph?.generation ?? null

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
      const suggestions = await suggestWikiTargets(query)
      return buildAutocompleteEntries(query, suggestions, { offerCreate: true }).map((entry) => {
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
        const { target, title, alias, date, path } = entry.suggestion
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
    [graph, settings.dateFormat, createFromAutocomplete],
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
