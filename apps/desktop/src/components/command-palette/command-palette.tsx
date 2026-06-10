import { useDeferredValue, useMemo, type ReactElement } from 'react'
import { Command } from 'cmdk'
import { useQuery } from '@tanstack/react-query'
import {
  hasBridge,
  parseHighlights,
  searchNotesRanked,
  suggestWikiTargets,
} from '@reflect/core'
import { listCommands, runCommand } from '@/lib/commands/registry'
import type { CommandContext } from '@/lib/commands/types'
import { formatDayLabel } from '@/lib/dates'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { buildPaletteSections, type NoteEntry } from './entries'
import { usePalette } from './palette-provider'

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
  const { graph } = useGraph()

  // Defer the query the index sees: fast typing coalesces (the plan's
  // debounce) while the input itself stays perfectly responsive.
  const trimmed = useDeferredValue(query.trim())
  const searching = open && hasBridge() && graph !== null && !trimmed.startsWith('>')
  const { data: suggestions, isLoading: suggestionsLoading } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'palette-suggest', trimmed],
    queryFn: () => suggestWikiTargets(trimmed, 8),
    enabled: searching,
  })
  const { data: hits } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'palette-search', trimmed],
    queryFn: () => searchNotesRanked(trimmed),
    enabled: searching && trimmed !== '',
  })

  const sections = useMemo(
    () =>
      buildPaletteSections({
        query,
        dataQuery: trimmed,
        suggestions: suggestions ?? [],
        hits: hits ?? [],
        commands: listCommands(),
      }),
    [query, trimmed, suggestions, hits],
  )

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
            {/* "No results" must mean the index answered, not "still loading" —
                the recall feed otherwise flashes a false empty on open.
                (isLoading, not isPending: a disabled query is forever pending.) */}
            {suggestionsLoading ? null : (
              <Command.Empty className="reflect-palette-empty">No results</Command.Empty>
            )}
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
