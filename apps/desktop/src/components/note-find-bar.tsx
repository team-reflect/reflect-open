import { useLayoutEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'
import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react'
import { getIsComposing } from '@meowdown/core'
import { SearchIcon } from '@/components/icons/search-icon'
import { useNoteFind } from '@/providers/note-find-provider'

const FIND_BUTTON_CLASS =
  'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:pointer-events-none disabled:opacity-40'

function statusText(active: number, total: number): string {
  if (total === 0) {
    return 'No matches'
  }
  return `Match ${active} of ${total}`
}

/** Compact, non-modal browser-style Find chrome for the active note. */
export function NoteFindBar(): ReactElement | null {
  const find = useNoteFind()
  const inputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    if (find.open) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [find.focusRequest, find.open])

  if (!find.open) {
    return null
  }

  const { active, total } = find.status
  const hasQuery = find.query.length > 0
  const canNavigate = total > 0

  function handleSearchKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (getIsComposing()) {
      return
    }
    if (event.key !== 'Escape') {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    find.close(true)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (getIsComposing()) {
      return
    }
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && key === 'f' && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.select()
      return
    }
    if (mod && key === 'g' && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) {
        find.previous()
      } else {
        find.next()
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) {
        find.previous()
      } else {
        find.next()
      }
    }
  }

  return (
    <div
      role="search"
      aria-label="Find in note"
      // Same frame as the sidebar's search field, so the two read as one
      // family. The bar is its own focus treatment: it exists only while its
      // input is focused, so a focus ring would draw a second box inside it.
      className="absolute top-2 right-3 z-40 flex max-w-[calc(100%_-_1.5rem)] items-center gap-1 rounded-[7px] border border-border-strong bg-input-bg py-1 pr-1 pl-1.5 shadow-app-input"
      onKeyDown={handleSearchKeyDown}
    >
      <SearchIcon className="size-[18px] shrink-0 text-text-muted" />
      <input
        ref={inputRef}
        aria-label="Find in note"
        autoComplete="off"
        className="reflect-find-input w-40 min-w-0 bg-transparent text-xs text-text placeholder:text-text-muted"
        placeholder="Find in note…"
        spellCheck={false}
        value={find.query}
        onChange={(event) => find.updateQuery(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      {hasQuery ? (
        <span
          role="status"
          aria-live="polite"
          className="shrink-0 text-2xs tabular-nums text-text-muted"
        >
          <span aria-hidden>
            {active}/{total}
          </span>
          <span className="sr-only">{statusText(active, total)}</span>
        </span>
      ) : null}
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
      <button
        type="button"
        aria-label="Previous match"
        className={FIND_BUTTON_CLASS}
        disabled={!canNavigate}
        onClick={find.previous}
      >
        <ChevronUpIcon className="size-3.5" strokeWidth={2} />
      </button>
      <button
        type="button"
        aria-label="Next match"
        className={FIND_BUTTON_CLASS}
        disabled={!canNavigate}
        onClick={find.next}
      >
        <ChevronDownIcon className="size-3.5" strokeWidth={2} />
      </button>
      <button
        type="button"
        aria-label="Close find"
        className={FIND_BUTTON_CLASS}
        onClick={() => find.close(true)}
      >
        <XIcon className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  )
}
