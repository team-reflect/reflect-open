import { useLayoutEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'
import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import { useNoteFind } from '@/providers/note-find-provider'

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

  const { active, total } = find.snapshot
  const hasQuery = find.query.length > 0
  const canNavigate = total > 0

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) {
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
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      find.close()
    }
  }

  return (
    <div
      role="search"
      aria-label="Find in note"
      className="absolute right-3 top-2 z-40 w-80 max-w-[calc(100%_-_1.5rem)]"
    >
      <InputGroup className="h-9 rounded-[7px] border-border-strong bg-input-bg shadow-pop">
        <InputGroupInput
          ref={inputRef}
          aria-label="Find in note"
          autoComplete="off"
          className="text-sm"
          placeholder="Find in note…"
          spellCheck={false}
          value={find.query}
          onChange={(event) => find.updateQuery(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <InputGroupAddon align="inline-end" className="gap-0 pr-1">
          {hasQuery ? (
            <span
              role="status"
              aria-live="polite"
              className="mr-1 min-w-11 text-center text-2xs tabular-nums text-text-muted"
            >
              <span aria-hidden>{active} / {total}</span>
              <span className="sr-only">{statusText(active, total)}</span>
            </span>
          ) : null}
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          <InputGroupButton
            aria-label="Previous match"
            disabled={!canNavigate}
            size="icon-xs"
            onClick={find.previous}
          >
            <ChevronUpIcon strokeWidth={1.75} />
          </InputGroupButton>
          <InputGroupButton
            aria-label="Next match"
            disabled={!canNavigate}
            size="icon-xs"
            onClick={find.next}
          >
            <ChevronDownIcon strokeWidth={1.75} />
          </InputGroupButton>
          <InputGroupButton aria-label="Close find" size="icon-xs" onClick={find.close}>
            <XIcon strokeWidth={1.75} />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}
