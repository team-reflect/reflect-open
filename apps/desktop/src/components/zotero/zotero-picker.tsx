import { useEffect, useState, type KeyboardEvent, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import {
  errorMessage,
  zoteroAbstractExcerpt,
  zoteroItemLink,
  zoteroItemSummary,
  zoteroSearch,
  type ZoteroItem,
} from '@reflect/core'
import { getIsComposing } from '@meowdown/core'
import { Kbd } from '@/components/kbd'
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
 * The dialog is cmdk-driven with the ⌘K palette's own frame — same overlay
 * position (`pt-[12vh]`), same `max-w-4xl` width and `min(60vh, 36rem)` list
 * height, same keyboard hint footer — so the Zotero picker feels like the
 * note search: ↑/↓ to move, Enter to pick, Esc to dismiss. `shouldFilter` is
 * off: the rows are server results, and ranking belongs to Zotero's own
 * search, not client-side filtering.
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

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (getIsComposing()) {
      // preventDefault keeps cmdk's root handler from selecting the highlighted
      // item on the Enter that commits the composition.
      if (event.key === 'Enter') {
        event.preventDefault()
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    // The overlay mirrors the ⌘K palette's (click-outside closes, Esc below):
    // same position, same click-to-dismiss contract.
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/20 pt-[12vh]"
      onPointerDown={onClose}
      data-testid="zotero-picker-overlay"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Insert Zotero item"
        className="w-full max-w-4xl"
        onPointerDown={(event) => {
          event.stopPropagation() // clicks inside must not close
        }}
      >
        <Command
          label="Insert Zotero item"
          shouldFilter={false}
          onKeyDown={handleKeyDown}
          className="reflect-palette"
        >
          <Command.Input
            autoFocus
            value={draft}
            onValueChange={setDraft}
            placeholder="Search your Zotero library…"
            className="reflect-palette-input"
          />
          <div className="flex h-[min(60vh,36rem)]">
            <Command.List className="h-full min-h-0 w-full overflow-y-auto px-1.5 py-1.5">
              {query === '' ? (
                <Command.Empty className="reflect-palette-empty">
                  Type to search your Zotero library (title, author, year).
                </Command.Empty>
              ) : error !== null ? (
                <Command.Empty className="reflect-palette-empty">
                  {errorMessage(error)}
                </Command.Empty>
              ) : (
                <>
                  {items?.map((item) => {
                    const summary = zoteroItemSummary(item)
                    const abstract = zoteroAbstractExcerpt(item)
                    return (
                      <Command.Item
                        key={item.key}
                        value={`zotero-${item.key}`}
                        onSelect={() => insert(item)}
                        className="reflect-palette-item"
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
                          <span className="w-full truncate text-sm font-medium">
                            {item.title.trim() === '' ? 'Untitled item' : item.title}
                          </span>
                          {summary !== '' ? (
                            <span className="w-full truncate text-xs text-text-muted">
                              {summary}
                            </span>
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
                      </Command.Item>
                    )
                  })}
                  {items === undefined ? (
                    <Command.Item disabled>Searching…</Command.Item>
                  ) : items.length === 0 ? (
                    <Command.Item disabled>No matching items.</Command.Item>
                  ) : null}
                </>
              )}
            </Command.List>
          </div>
          <div
            aria-hidden
            className="flex items-center gap-4 border-t border-border px-3.5 py-2 text-[11px] text-text-muted"
          >
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> Navigate
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↩</Kbd> Insert
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>esc</Kbd> Cancel
            </span>
          </div>
        </Command>
      </div>
    </div>
  )
}
