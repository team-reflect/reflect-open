import { useEffect, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  errorMessage,
  zoteroAbstractExcerpt,
  zoteroItemLink,
  zoteroItemSummary,
  zoteroSearch,
  type ZoteroItem,
} from '@reflect/core'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { closeZoteroPicker, useZoteroPicker } from '@/components/zotero/zotero-picker-store'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry'
import { startOperation } from '@/lib/operations'

const SEARCH_DEBOUNCE_MS = 250

/**
 * The "Insert Zotero item" picker: type to search the local Zotero library
 * (title / author / year, via Zotero 7's Local API), then pick an item to
 * insert its `[Title](zotero://…)` deep link at the caret of the note the
 * opener targeted. Mirrors the zotero-link Obsidian plugin's flow.
 *
 * The dialog is cmdk-driven (the ⌘K palette's component), so the candidate
 * list supports the same keyboard traversal — ↑/↓ to move, Enter to pick,
 * Esc to dismiss. `shouldFilter` is off: the rows are server results, and
 * ranking belongs to Zotero's own search, not client-side filtering.
 *
 * The target note is captured at open time (`targetPath`); at insert time it
 * resolves to the pane's live editor handle, so a protected or unloaded note
 * surfaces as a failed operation instead of a silent nothing.
 */

export function ZoteroPicker(): ReactElement | null {
  const picker = useZoteroPicker()

  if (picker === null) {
    return null
  }

  // Keyed by the open epoch: every invocation remounts a fresh dialog, so the
  // search state below never needs a reset effect.
  return (
    <ZoteroPickerDialog
      key={picker.epoch}
      targetPath={picker.targetPath}
      onClose={closeZoteroPicker}
    />
  )
}

function ZoteroPickerDialog({
  targetPath,
  onClose,
}: {
  targetPath: string | null
  onClose: () => void
}): ReactElement {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')

  // Debounce keystrokes into the react-query key so Zotero isn't queried per
  // keypress.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(draft.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft])

  const { data: items, error } = useQuery({
    queryKey: ['zotero-search', query],
    queryFn: () => zoteroSearch(query),
    enabled: query !== '',
    staleTime: 30_000,
  })

  const insert = (item: ZoteroItem): void => {
    onClose()
    const editor = targetPath !== null ? noteEditorHandleFor(targetPath) : null
    if (editor === null) {
      startOperation('Inserting Zotero link').fail('No open note to insert into')
      return
    }
    editor.insertMarkdown(zoteroItemLink(item))
    editor.focus()
  }

  return (
    <CommandDialog
      title="Insert Zotero item"
      description="Search your Zotero library and insert the selected item's link"
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
      className="sm:max-w-3xl"
    >
      <Command shouldFilter={false} label="Search Zotero">
        <CommandInput
          autoFocus
          value={draft}
          onValueChange={setDraft}
          placeholder="Search your Zotero library…"
        />
        <CommandList>
          {query === '' ? (
            <CommandEmpty>Type to search your Zotero library (title, author, year).</CommandEmpty>
          ) : error !== null ? (
            <CommandEmpty>{errorMessage(error)}</CommandEmpty>
          ) : (
            <CommandGroup>
              {items?.map((item) => {
                const summary = zoteroItemSummary(item)
                const abstract = zoteroAbstractExcerpt(item)
                return (
                  <CommandItem
                    key={item.key}
                    value={`zotero-${item.key}`}
                    onSelect={() => insert(item)}
                    className="items-start gap-2"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
                      <span className="w-full truncate text-sm font-medium">
                        {item.title.trim() === '' ? 'Untitled item' : item.title}
                      </span>
                      {summary !== '' ? (
                        <span className="w-full truncate text-xs text-text-muted">{summary}</span>
                      ) : null}
                      {abstract !== '' ? (
                        <span className="line-clamp-2 w-full text-xs text-text-secondary">
                          {abstract}
                        </span>
                      ) : null}
                      {item.url !== null && item.url.trim() !== '' ? (
                        <span className="w-full truncate font-mono text-[11px] text-text-muted">
                          {item.url}
                        </span>
                      ) : null}
                    </span>
                  </CommandItem>
                )
              })}
              {items === undefined ? (
                <CommandItem disabled>Searching…</CommandItem>
              ) : items.length === 0 ? (
                <CommandItem disabled>No matching items.</CommandItem>
              ) : null}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
