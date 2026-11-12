import { memo, useMemo, useState, type ReactElement } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import { CalendarDays, FileText } from 'lucide-react'
import { getIsComposing, isModEvent } from '@meowdown/core'
import { Kbd } from '@/components/kbd.tsx'
import { ShortcutKeys } from '@/components/shortcut-keys.tsx'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import type { AppCommand, CommandContext } from '@/lib/commands/types.ts'
import { displayNoteTitle, parseHighlights, formatDayLabel, type DateFormat } from '@reflect/core'
import { routeForPath, type NoteEntry } from '@reflect/app'
import { cn } from '@/lib/utils.ts'
import { useDateFormat } from '@/providers/settings-provider.tsx'
import { COMMAND_ICONS, FALLBACK_COMMAND_ICON } from './command-icons.ts'
import { NotePreview } from './note-preview.tsx'
import { usePalette } from './palette-provider.tsx'
import { usePaletteResults } from './use-palette-results.ts'

/**
 * The ⌘K palette (Plan 08): one keyboard surface for find / navigate / do.
 * Base UI's inline Autocomplete owns traversal (↑/↓/Enter) and we own
 * ranking (`mode="none"` — the index already ordered everything). Empty
 * query = recent notes (the recall feed, decided); `>` filters to commands.
 *
 * Note modes render two panes — results beside a live preview of the
 * highlighted note. Command mode (`>`) stays the original single narrow column.
 */

interface CommandPaletteProps {
  /** The capabilities commands run with (built by the shortcuts hook's owner). */
  context: CommandContext
}

type PaletteItem = { kind: 'note'; entry: NoteEntry } | { kind: 'command'; command: AppCommand }

interface PaletteGroup {
  value: string
  items: PaletteItem[]
}

const Snippet = memo(function Snippet({ snippet }: { snippet: string }): ReactElement {
  return (
    <span className="block truncate text-xs text-text-muted">
      {parseHighlights(snippet).map((segment, i) => {
        return segment.highlighted ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-0.5">
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        )
      })}
    </span>
  )
})

export function CommandPalette({ context }: CommandPaletteProps): ReactElement | null {
  const { open, query, setQuery, closePalette } = usePalette()
  const dateFormat = useDateFormat()
  const { sections, resultsSettled, searchFailed } = usePaletteResults(open, query)
  const navigateNoteLink = useNoteLinkNavigation()
  const [highlighted, setHighlighted] = useState<PaletteItem | undefined>(undefined)

  const groups = useMemo((): PaletteGroup[] => {
    const result: PaletteGroup[] = []
    if (sections.notes.length > 0) {
      result.push({
        value: query.trim() === '' ? 'Recent' : 'Notes',
        items: sections.notes.map((entry) => ({ kind: 'note', entry })),
      })
    }
    if (sections.commands.length > 0) {
      result.push({
        value: 'Commands',
        items: sections.commands.map((command) => ({ kind: 'command', command })),
      })
    }
    return result
  }, [sections, query])

  if (!open) {
    return null
  }

  const activate = (item: PaletteItem, openInNewWindow: boolean): void => {
    closePalette()
    if (item.kind === 'note') {
      navigateNoteLink({ target: routeForPath(item.entry.path), openInNewWindow })
    } else {
      void context.app.commands.run(item.command.id, context)
    }
  }

  // Width follows the palette's *mode*, not the result count: note modes keep
  // the preview pane (placeholder included) so the frame never jumps while
  // results stream in; `>` command mode stays the narrow single column.
  const splitLayout = !sections.commandsOnly
  const selectedNote =
    splitLayout && highlighted?.kind === 'note'
      ? (sections.notes.find((entry) => entry.path === highlighted.entry.path) ?? null)
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
        className={cn('reflect-palette w-full', splitLayout ? 'max-w-4xl' : 'max-w-xl')}
        onPointerDown={(event) => {
          event.stopPropagation() // clicks inside must not close
        }}
      >
        <Autocomplete.Root
          inline
          open
          mode="none"
          items={groups}
          value={query}
          onValueChange={setQuery}
          onItemHighlighted={setHighlighted}
          autoHighlight="always"
          keepHighlight
        >
          <Autocomplete.Input
            autoFocus
            aria-label="Command palette"
            placeholder="Search notes, or > for commands…"
            className="reflect-palette-input"
            onKeyDown={(event) => {
              if (getIsComposing()) {
                // The Enter that commits a composition must not pick the highlighted item.
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.preventBaseUIHandler()
                }
                return
              }
              // Base UI skips modified keys, so Mod+Enter is ours.
              if (event.key === 'Enter' && isModEvent(event) && highlighted !== undefined) {
                event.preventDefault()
                activate(highlighted, true)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                closePalette()
              }
            }}
          />
          <div className={cn(splitLayout && 'flex h-[min(60vh,36rem)]')}>
            <Autocomplete.List
              className={cn('reflect-palette-list', splitLayout && 'reflect-palette-list-split')}
            >
              {searchFailed ? (
                <div role="alert" className="reflect-palette-empty">
                  Search unavailable — the index didn’t answer.
                </div>
              ) : null}
              <Autocomplete.Empty>
                {resultsSettled && !searchFailed ? (
                  <div className="reflect-palette-empty">No results</div>
                ) : null}
              </Autocomplete.Empty>
              {groups.map((group) => (
                <Autocomplete.Group key={group.value} items={group.items}>
                  <Autocomplete.GroupLabel className="reflect-palette-group-label">
                    {group.value}
                  </Autocomplete.GroupLabel>
                  <Autocomplete.Collection>
                    {(item: PaletteItem) => {
                      return item.kind === 'note' ? (
                        <NoteItem
                          key={item.entry.path}
                          item={item}
                          dateFormat={dateFormat}
                          onClick={(event) => activate(item, isModEvent(event))}
                        />
                      ) : (
                        <CommandItem
                          key={item.command.id}
                          item={item}
                          onClick={() => activate(item, false)}
                        />
                      )
                    }}
                  </Autocomplete.Collection>
                </Autocomplete.Group>
              ))}
            </Autocomplete.List>
            {splitLayout ? (
              <div className="min-w-0 flex-1 overflow-y-auto border-l border-border">
                {selectedNote !== null ? (
                  // A stable key keeps the preview pane mounted as the highlight
                  // moves between results (↑/↓): the entry prop updates and the
                  // query refetches by its own path-scoped key, so an arrow-key
                  // press does not remount the preview subtree.
                  <NotePreview key="note-preview" entry={selectedNote} />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-text-muted">
                    No note selected
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </Autocomplete.Root>
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
          {splitLayout ? (
            <span className="flex items-center gap-1.5">
              <ShortcutKeys binding="Mod-Enter" /> Open in new window
            </span>
          ) : null}
          <span className="flex items-center gap-1.5">
            <Kbd>esc</Kbd> Close
          </span>
        </div>
      </div>
    </div>
  )
}

interface NoteItemProps {
  item: Extract<PaletteItem, { kind: 'note' }>
  dateFormat: DateFormat
  onClick: (event: React.MouseEvent) => void
}

function NoteItem({ item, dateFormat, onClick }: NoteItemProps): ReactElement {
  const { entry } = item
  const Icon = entry.date !== null ? CalendarDays : FileText
  return (
    <Autocomplete.Item value={item} onClick={onClick} className="reflect-palette-item">
      <span className="flex items-center gap-2.5">
        <Icon aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">
            {entry.phrase !== null
              ? entry.phrase
              : entry.date !== null
                ? formatDayLabel(entry.date, dateFormat)
                : displayNoteTitle(entry.title)}
          </span>
          {entry.phrase !== null && entry.date !== null ? (
            <span className="block truncate text-xs text-text-muted">
              {formatDayLabel(entry.date, dateFormat)}
            </span>
          ) : null}
          {entry.alias !== null ? (
            <span className="block truncate text-xs text-text-muted">
              {entry.alias} → {displayNoteTitle(entry.title)}
            </span>
          ) : null}
          {entry.snippet !== null ? <Snippet snippet={entry.snippet} /> : null}
        </span>
      </span>
    </Autocomplete.Item>
  )
}

interface CommandItemProps {
  item: Extract<PaletteItem, { kind: 'command' }>
  onClick: () => void
}

function CommandItem({ item, onClick }: CommandItemProps): ReactElement {
  const { command } = item
  const Icon = COMMAND_ICONS[command.id] ?? FALLBACK_COMMAND_ICON
  return (
    <Autocomplete.Item value={item} onClick={onClick} className="reflect-palette-item">
      <span className="flex items-center gap-2.5">
        <Icon aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 truncate text-sm">{command.title}</span>
        {command.keybinding ? <ShortcutKeys binding={command.keybinding} /> : null}
      </span>
    </Autocomplete.Item>
  )
}
