import { Fragment, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { CalendarDays, FileText, History, Paperclip, Search, TextSearch } from 'lucide-react'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { useRouterActions } from '@/routing/router.tsx'
import { isModEvent } from '@meowdown/core'
import { useDateFormat } from '@/providers/settings-provider.tsx'
import { useNoteLabel } from '@/hooks/use-note-label.ts'
import {
  isTagName,
  isToolPending,
  type AssistantPart,
  type NoteHitSummary,
  formatShortDate,
} from '@reflect/core'
import { routeForPath } from '@reflect/app'

interface ChatToolChipProps {
  part: Extract<AssistantPart, { kind: 'tool' }>
}

/** ` · 3 notes` — the settled count suffix of a listing chip. */
function countSuffix(count: number, noun: string): string {
  return ` · ${count} ${noun}${count === 1 ? '' : 's'}`
}

/** An asset chip labels entries by filename — the path adds only noise. */
function assetName(path: string): string {
  return path.split('/').pop() ?? path
}

interface ChipFrameProps {
  pending: boolean
  icon: ReactElement
  children: ReactNode
}

/** The shared marker shell: a spinner while pending, the tool's icon after. */
function ChipFrame({ pending, icon, children }: ChipFrameProps): ReactElement {
  return (
    <Marker className="text-xs text-text-muted">
      <MarkerIcon>{pending ? <Spinner /> : icon}</MarkerIcon>
      <MarkerContent className="truncate">{children}</MarkerContent>
    </Marker>
  )
}

interface NoteLinksProps {
  notes: readonly NoteHitSummary[]
  onOpen: (path: string, event: MouseEvent<HTMLButtonElement>) => void
}

function NoteLinks({ notes, onOpen }: NoteLinksProps): ReactElement | null {
  const noteLabel = useNoteLabel()
  if (notes.length === 0) {
    return null
  }

  return (
    <>
      {': '}
      {notes.map((note, index) => (
        <Fragment key={`${note.path}-${index}`}>
          {index > 0 ? ', ' : ''}
          <button
            type="button"
            onClick={(event) => onOpen(note.path, event)}
            className="underline-offset-2 hover:text-text hover:underline"
          >
            {noteLabel(note)}
          </button>
        </Fragment>
      ))}
    </>
  )
}

/**
 * The transparent-context chip for one tool call: what the assistant searched
 * for or listed (and how many notes came back), or which note it read.
 * Successful read chips click through to the note; a refused or failed read
 * shows the failure instead of pretending the note was used. This is the only
 * UI that knows tool names — new tools extend `tools.ts` and this switch.
 */
export function ChatToolChip({ part }: ChatToolChipProps): ReactElement {
  const { navigate } = useRouterActions()
  const navigateNoteLink = useNoteLinkNavigation()
  const openNote = (path: string, event: MouseEvent<HTMLButtonElement>): void => {
    navigateNoteLink({ target: routeForPath(path), openInNewWindow: isModEvent(event) })
  }
  const pending = isToolPending(part)
  const noteLabel = useNoteLabel()
  const dateFormat = useDateFormat()
  const call = part.call

  if (call.tool === 'search') {
    const result = part.result?.tool === 'search' ? part.result : null
    return (
      <ChipFrame pending={pending} icon={<Search aria-hidden className="size-3.5" />}>
        Searched “{call.query}”{result !== null ? countSuffix(result.hits.length, 'note') : ''}
        {result !== null ? <NoteLinks notes={result.hits} onOpen={openNote} /> : null}
      </ChipFrame>
    )
  }

  if (call.tool === 'find') {
    const result = part.result?.tool === 'find' ? part.result : null
    const groups = call.groups
      .map((group) => {
        const words = group.map((word) => `“${word}”`).join(' or ')
        return call.groups.length > 1 && group.length > 1 ? `(${words})` : words
      })
      .join(' and ')
    const range =
      call.from !== null || call.to !== null
        ? ` in ${call.from !== null ? formatShortDate(call.from, dateFormat) : '…'} – ${
            call.to !== null ? formatShortDate(call.to, dateFormat) : '…'
          }`
        : ''
    const linked = call.linksTo !== null ? ` linking to ${call.linksTo}` : ''
    // A thrown call (part.error) or a refusal (result.error) shows its reason
    // instead of a count, so a failed search never reads as an empty one.
    const failure = part.error ?? result?.error ?? null
    return (
      // Outcome, then what was searched, then the note links: the links can run
      // long, so they go last, where the truncation falls.
      <ChipFrame pending={pending} icon={<TextSearch aria-hidden className="size-3.5" />}>
        {failure !== null
          ? `Couldn't find ${groups}${range}${linked} — ${failure}`
          : `${
              result !== null
                ? `Found ${result.notes.length} note${result.notes.length === 1 ? '' : 's'}${
                    result.truncated ? ' (more matched)' : ''
                  }`
                : 'Finding'
            } for ${groups}${range}${linked}`}
        {result !== null && failure === null ? (
          <NoteLinks notes={result.notes} onOpen={openNote} />
        ) : null}
      </ChipFrame>
    )
  }

  if (call.tool === 'recents') {
    const result = part.result?.tool === 'recents' ? part.result : null
    const tagLabel =
      call.tag !== null && isTagName(call.tag) ? (
        <button
          type="button"
          onClick={() => navigate({ kind: 'allNotes', tag: call.tag })}
          className="underline-offset-2 hover:text-text hover:underline"
        >
          #{call.tag}
        </button>
      ) : call.tag !== null ? (
        `#${call.tag}`
      ) : (
        'recent'
      )
    return (
      <ChipFrame pending={pending} icon={<History aria-hidden className="size-3.5" />}>
        Listed {tagLabel} notes
        {result !== null
          ? result.error !== null
            ? ` — ${result.error}`
            : countSuffix(result.notes.length, 'note')
          : ''}
        {result !== null && result.error === null ? (
          <NoteLinks notes={result.notes} onOpen={openNote} />
        ) : null}
      </ChipFrame>
    )
  }

  if (call.tool === 'dailies') {
    const result = part.result?.tool === 'dailies' ? part.result : null
    return (
      <ChipFrame pending={pending} icon={<CalendarDays aria-hidden className="size-3.5" />}>
        Listed daily notes {formatShortDate(call.start, dateFormat)} –{' '}
        {formatShortDate(call.end, dateFormat)}
        {result !== null ? countSuffix(result.days.length, 'day') : ''}
        {result !== null ? <NoteLinks notes={result.days} onOpen={openNote} /> : null}
      </ChipFrame>
    )
  }

  // read_assets: one chip for the whole batch of attachment descriptions.
  // Assets have no note route, so entries stay plain text with per-asset
  // refusals inline.
  if (call.tool === 'assets') {
    const result = part.result?.tool === 'assets' ? part.result : null
    if (part.error !== null) {
      return (
        <ChipFrame pending={false} icon={<Paperclip aria-hidden className="size-3.5" />}>
          {call.paths.map(assetName).join(', ')} — {part.error}
        </ChipFrame>
      )
    }
    const assets = result?.assets ?? call.paths.map((path) => ({ path, error: null }))
    return (
      <ChipFrame pending={pending} icon={<Paperclip aria-hidden className="size-3.5" />}>
        Read{' '}
        {assets.map((asset, index) => (
          <Fragment key={`${asset.path}-${index}`}>
            {index > 0 ? ', ' : ''}
            <span>
              {assetName(asset.path)}
              {asset.error !== null ? ` — ${asset.error}` : ''}
            </span>
          </Fragment>
        ))}
      </ChipFrame>
    )
  }

  // read_notes: one chip for the whole batch. A tool-level error fails it as a
  // unit; otherwise each note links through on its own, or shows its refusal.
  const result = part.result?.tool === 'read' ? part.result : null
  if (part.error !== null) {
    return (
      <ChipFrame pending={false} icon={<FileText aria-hidden className="size-3.5" />}>
        {call.paths.join(', ')} — {part.error}
      </ChipFrame>
    )
  }
  // Settled, we know each note's title/error; pending, only the requested paths.
  const notes = result?.notes ?? call.paths.map((path) => ({ path, title: null, error: null }))
  return (
    <ChipFrame pending={pending} icon={<FileText aria-hidden className="size-3.5" />}>
      Read{' '}
      {notes.map((note, index) => {
        const label =
          note.title !== null ? noteLabel({ path: note.path, title: note.title }) : note.path
        return (
          <Fragment key={`${note.path}-${index}`}>
            {index > 0 ? ', ' : ''}
            {!pending && note.error === null ? (
              <button
                type="button"
                onClick={(event) => openNote(note.path, event)}
                className="underline-offset-2 hover:text-text hover:underline"
              >
                {label}
              </button>
            ) : (
              <span>
                {label}
                {note.error !== null ? ` — ${note.error}` : ''}
              </span>
            )}
          </Fragment>
        )
      })}
    </ChipFrame>
  )
}
