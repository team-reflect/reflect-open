import { type ReactElement } from 'react'
import { Command } from 'cmdk'
import { parseHighlights } from '@reflect/core'
import { runCommand } from '@/lib/commands/registry'
import type { CommandContext } from '@/lib/commands/types'
import { formatDayLabel } from '@/lib/dates'
import { routeForPath } from '@/routing/route'
import { type NoteEntry } from './entries'
import { usePalette } from './palette-provider'
import { usePaletteResults } from './use-palette-results'

/**
 * The ⌘K palette (Plan 08): one keyboard surface for find / navigate / do.
 * cmdk owns traversal (↑/↓/Enter/Esc) and we own ranking (`shouldFilter`
 * off — the index already ordered everything). Empty query = recent notes
 * (the recall feed, decided); `>` filters to commands.
 */

interface CommandPaletteProps {
  /** The capabilities commands run with (built by the shortcuts hook's owner). */
  context: CommandContext
}

function Snippet({ snippet }: { snippet: string }): ReactElement {
  return (
    <span className="block truncate text-xs text-[color:var(--text-muted)]">
      {parseHighlights(snippet).map((segment, i) =>
        segment.highlighted ? (
          <mark key={i} className="rounded-sm bg-[var(--accent-soft,rgb(99_102_241/0.2))] px-0.5">
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
  const { sections, resultsSettled, searchFailed } = usePaletteResults(open, query)

  if (!open) {
    return null
  }

  const openNote = (entry: NoteEntry): void => {
    closePalette()
    context.navigate(routeForPath(entry.path))
  }

  return (
    // The overlay is ours (no portal): click-outside closes, Esc closes below.
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/20 pt-[12vh]"
      onPointerDown={closePalette}
      data-testid="palette-overlay"
    >
      <div
        className="w-full max-w-xl"
        onPointerDown={(event) => {
          event.stopPropagation() // clicks inside must not close
        }}
      >
        <Command
          label="Command palette"
          shouldFilter={false}
          onKeyDown={(event) => {
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
          <Command.List className="reflect-palette-list">
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
                {sections.notes.map((entry) => (
                  <Command.Item
                    key={entry.path}
                    value={entry.path}
                    onSelect={() => openNote(entry)}
                    className="reflect-palette-item"
                  >
                    <span className="block truncate text-sm">
                      {entry.date !== null ? formatDayLabel(entry.date) : entry.title}
                    </span>
                    {entry.snippet !== null ? <Snippet snippet={entry.snippet} /> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            {sections.commands.length > 0 ? (
              <Command.Group heading="Commands" className="reflect-palette-group">
                {sections.commands.map((command) => (
                  <Command.Item
                    key={command.id}
                    value={`command:${command.id}`}
                    onSelect={() => {
                      closePalette()
                      void runCommand(command.id, context)
                    }}
                    className="reflect-palette-item"
                  >
                    <span className="block truncate text-sm">{command.title}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
