import { useState, type ReactElement } from 'react'
import { CalendarDays, FileText, Search } from 'lucide-react'
import { routeForPath, type NoteEntry } from '@reflect/app'
import { WritableStore, displayNoteTitle, formatDayLabel } from '@reflect/core'
import { usePaletteResults } from '@/components/command-palette/use-palette-results.ts'
import { useStore } from '@/lib/use-store.ts'
import { useAllSearch } from '@/mobile/all-search.tsx'
import { MobileAskRow } from '@/mobile/ask-row.tsx'
import { useDateFormat } from '@/providers/settings-provider.tsx'
import { useRouterActions } from '@/routing/router.tsx'

/**
 * Whether Quick Open is showing. The iPad sidebar's Search row and ⌘K set it.
 */
export const quickOpenVisible = new WritableStore(false)

/**
 * Quick Open on the iPad with a sidebar: a search over the screen on view,
 * with the ⌘K palette's results. An empty query shows recent notes; the last
 * rows ask Chat or show every result in All. Only a choice navigates, so
 * looking something up and closing leaves history as it was. Return opens
 * the top note; ⌘Return shows the results in All.
 */
export function MobileQuickOpen(): ReactElement | null {
  const open = useStore(quickOpenVisible)
  return open ? <QuickOpenPanel /> : null
}

function QuickOpenPanel(): ReactElement {
  const [query, setQuery] = useState('')
  const { sections } = usePaletteResults(true, query)
  const { navigate, selectSection } = useRouterActions()
  const [, setAllQuery] = useAllSearch()
  const dateFormat = useDateFormat()
  // `>` lists desktop commands, which run with a desktop context only.
  const notes = sections.commandsOnly ? [] : sections.notes
  const question = query.trim()
  const close = (): void => quickOpenVisible.set(false)

  const openNote = (entry: NoteEntry): void => {
    close()
    navigate(routeForPath(entry.path))
  }
  const seeAll = (): void => {
    close()
    setAllQuery(query)
    selectSection('all')
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/20 px-safe-offset-4 pt-[12vh]"
      onPointerDown={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quick Open"
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <label className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Search aria-hidden className="size-4 shrink-0 text-text-muted" />
          <input
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            type="search"
            aria-label="Quick Open"
            placeholder="Search notes"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                close()
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                seeAll()
              } else if (event.key === 'Enter' && notes[0] !== undefined) {
                openNote(notes[0])
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-base outline-none"
          />
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {notes.length > 0 ? (
            <div className="px-4 pt-3 pb-1 text-xs font-medium text-text-muted">
              {question === '' ? 'Recent' : 'Notes'}
            </div>
          ) : null}
          {notes.map((entry) => {
            const Icon = entry.date !== null ? CalendarDays : FileText
            return (
              <button
                key={entry.path}
                type="button"
                onClick={() => openNote(entry)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left active:bg-surface-sunken"
              >
                <Icon aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {entry.date !== null
                    ? formatDayLabel(entry.date, dateFormat)
                    : displayNoteTitle(entry.title)}
                </span>
              </button>
            )
          })}
          {question === '' ? null : (
            <div className="mt-1 border-t border-border">
              <div onClick={close}>
                <MobileAskRow query={query} />
              </div>
              <button
                type="button"
                onClick={seeAll}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm active:bg-surface-sunken"
              >
                <Search aria-hidden className="size-4 shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1 truncate">See all in All</span>
                <span className="text-xs text-text-muted">⌘↩</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
