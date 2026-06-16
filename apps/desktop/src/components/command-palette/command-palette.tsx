import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Command } from 'cmdk'
import { parseHighlights } from '@reflect/core'
import { CalendarDays, FileText } from 'lucide-react'
import { Kbd } from '@/components/kbd'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { runCommand } from '@/lib/commands/registry'
import type { CommandContext } from '@/lib/commands/types'
import { formatDayLabel } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'
import { routeForPath } from '@/routing/route'
import { commandIcon } from './command-icons'
import { type NoteEntry } from './entries'
import { NotePreview } from './note-preview'
import { usePalette } from './palette-provider'
import { usePaletteResults } from './use-palette-results'

/**
 * The ⌘K palette (Plan 08): one keyboard surface for find / navigate / do.
 * cmdk owns traversal (↑/↓/Enter/Esc) and we own ranking (`shouldFilter`
 * off — the index already ordered everything). Empty query = recent notes
 * (the recall feed, decided); `>` filters to commands.
 *
 * Note modes render two panes — results beside a live preview of the
 * highlighted note (cmdk's selection, mirrored via controlled `value`).
 * Command mode (`>`) stays the original single narrow column.
 */

interface CommandPaletteProps {
  /** The capabilities commands run with (built by the shortcuts hook's owner). */
  context: CommandContext
}

function Snippet({ snippet }: { snippet: string }): ReactElement {
  return (
    <span className="block truncate text-xs text-text-muted">
      {parseHighlights(snippet).map((segment, i) =>
        segment.highlighted ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-0.5">
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </span>
  )
}

export function CommandPalette({ context }: CommandPaletteProps): ReactElement | null {
  const { open, query, setQuery, closePalette } = usePalette()
  const { settings } = useSettings()
  const { sections, resultsSettled, searchFailed } = usePaletteResults(open, query)
  // cmdk's highlighted item, mirrored so the preview pane can follow it. Reset
  // on close so a reopened palette highlights its first result, not the last
  // session's pick.
  const [selectedValue, setSelectedValue] = useState('')
  // Reset on close so a reopened palette highlights its first result, not the
  // last session's pick. Adjusting during render avoids a prop-syncing effect.
  const [appliedOpen, setAppliedOpen] = useState(open)
  if (appliedOpen !== open) {
    setAppliedOpen(open)
    if (!open) {
      setSelectedValue('')
    }
  }
  // Each new result set highlights its top note. Without this, cmdk keeps any
  // still-valid selection — and commands match synchronously while notes load
  // async, so the first command would stay highlighted over the top hit. Keyed
  // on the list's *content*, not array identity, so a refetch or deferred-query
  // settle that reproduces the same list never moves a selection the user made;
  // the selection rides in a ref for the same reason. With no notes at all, a
  // stale note selection clears so cmdk's first-item default can highlight a
  // matching command (Enter must always have a target).
  const selectedValueRef = useRef(selectedValue)
  const notesRef = useRef(sections.notes)
  useEffect(() => {
    selectedValueRef.current = selectedValue
    notesRef.current = sections.notes
  })
  const notesKey = sections.notes.map((entry) => entry.path).join('\n')
  useEffect(() => {
    if (!open) {
      return
    }
    const notes = notesRef.current
    if (notes.length > 0) {
      if (!notes.some((entry) => entry.path === selectedValueRef.current)) {
        setSelectedValue(notes[0]!.path)
      }
    } else if (!selectedValueRef.current.startsWith('command:')) {
      setSelectedValue('')
    }
  }, [open, notesKey])

  if (!open) {
    return null
  }

  const openNote = (entry: NoteEntry): void => {
    closePalette()
    context.navigate(routeForPath(entry.path))
  }

  // Width follows the palette's *mode*, not the result count: note modes keep
  // the preview pane (placeholder included) so the frame never jumps while
  // results stream in; `>` command mode stays the narrow single column.
  const splitLayout = !sections.commandsOnly
  const selectedNote = splitLayout
    ? (sections.notes.find((entry) => entry.path === selectedValue) ?? null)
    : null

  return (
    // The overlay is ours (no portal): click-outside closes, Esc closes below.
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/20 pt-[12vh]"
      onPointerDown={closePalette}
      data-testid="palette-overlay"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={cn('w-full', splitLayout ? 'max-w-4xl' : 'max-w-xl')}
        onPointerDown={(event) => {
          event.stopPropagation() // clicks inside must not close
        }}
      >
        <Command
          label="Command palette"
          shouldFilter={false}
          value={selectedValue}
          onValueChange={setSelectedValue}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              closePalette()
            }
          }}
          className="reflect-palette"
        >
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search notes, or > for commands…"
            className="reflect-palette-input"
          />
          <div className={cn(splitLayout && 'flex h-[min(60vh,36rem)]')}>
            <Command.List
              className={cn('reflect-palette-list', splitLayout && 'reflect-palette-list-split')}
            >
              {searchFailed ? (
                <div role="alert" className="reflect-palette-empty">
                  Search unavailable — the index didn’t answer.
                </div>
              ) : null}
              {resultsSettled && !searchFailed ? (
                <Command.Empty className="reflect-palette-empty">No results</Command.Empty>
              ) : null}
              {sections.notes.length > 0 ? (
                <Command.Group
                  heading={query.trim() === '' ? 'Recent' : 'Notes'}
                  className="reflect-palette-group"
                >
                  {sections.notes.map((entry) => {
                    const Icon = entry.date !== null ? CalendarDays : FileText
                    return (
                      <Command.Item
                        key={entry.path}
                        value={entry.path}
                        onSelect={() => openNote(entry)}
                        className="reflect-palette-item"
                      >
                        <span className="flex items-center gap-2.5">
                          <Icon
                            aria-hidden
                            strokeWidth={1.75}
                            className="size-4 shrink-0 text-text-muted"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">
                              {entry.date !== null
                                ? formatDayLabel(entry.date, settings.dateFormat)
                                : entry.title}
                            </span>
                            {entry.snippet !== null ? <Snippet snippet={entry.snippet} /> : null}
                          </span>
                        </span>
                      </Command.Item>
                    )
                  })}
                </Command.Group>
              ) : null}
              {sections.commands.length > 0 ? (
                <Command.Group heading="Commands" className="reflect-palette-group">
                  {sections.commands.map((command) => {
                    const Icon = commandIcon(command.id)
                    return (
                      <Command.Item
                        key={command.id}
                        value={`command:${command.id}`}
                        onSelect={() => {
                          closePalette()
                          void runCommand(command.id, context)
                        }}
                        className="reflect-palette-item"
                      >
                        <span className="flex items-center gap-2.5">
                          <Icon
                            aria-hidden
                            strokeWidth={1.75}
                            className="size-4 shrink-0 text-text-muted"
                          />
                          <span className="min-w-0 flex-1 truncate text-sm">{command.title}</span>
                          {command.keybinding ? <ShortcutKeys binding={command.keybinding} /> : null}
                        </span>
                      </Command.Item>
                    )
                  })}
                </Command.Group>
              ) : null}
            </Command.List>
            {splitLayout ? (
              <div className="min-w-0 flex-1 overflow-y-auto border-l border-border">
                {selectedNote !== null ? (
                  <NotePreview key={selectedNote.path} entry={selectedNote} />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-text-muted">
                    No note selected
                  </div>
                )}
              </div>
            ) : null}
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
              <Kbd>↩</Kbd> Open
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>esc</Kbd> Close
            </span>
          </div>
        </Command>
      </div>
    </div>
  )
}
