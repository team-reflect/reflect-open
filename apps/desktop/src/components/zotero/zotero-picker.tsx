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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
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

  const {
    data: items,
    isFetching,
    error,
  } = useQuery({
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
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="grid max-h-[calc(100dvh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden sm:max-w-3xl"
      >
        <DialogHeader className="pr-8">
          <DialogTitle>Insert Zotero item</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search your Zotero library…"
          aria-label="Search Zotero"
        />
        <div className="min-h-0 overflow-y-auto pr-1">
          {query === '' ? (
            <p className="px-3 py-8 text-center text-sm text-text-muted">
              Type to search your Zotero library (title, author, year).
            </p>
          ) : error !== null ? (
            <p className="px-3 py-8 text-center text-sm text-text-muted">{errorMessage(error)}</p>
          ) : items !== undefined && items.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-text-muted">
              {isFetching ? 'Searching…' : 'No matching items.'}
            </p>
          ) : (
            <ul className="flex flex-col">
              {items?.map((item) => {
                const summary = zoteroItemSummary(item)
                const abstract = zoteroAbstractExcerpt(item)
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      onClick={() => insert(item)}
                      className="flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-hover focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
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
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
