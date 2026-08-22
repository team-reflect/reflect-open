import { Fragment, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import {
  CalendarDays,
  FilePlus2,
  FileText,
  History,
  Paperclip,
  PencilLine,
  Search,
} from 'lucide-react'
import {
  isTagName,
  isToolPending,
  type AssistantPart,
  type NoteHitSummary,
  type NoteMutationOutput,
} from '@reflect/core'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import { Spinner } from '@/components/ui/spinner'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { isModEvent } from '@meowdown/core'

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
            {note.title}
          </button>
        </Fragment>
      ))}
    </>
  )
}

interface MutationChipProps {
  pending: boolean
  icon: ReactElement
  pendingLabel: string
  verb: string
  label: string
  showStatistics?: boolean
  outcome: NoteMutationOutput | null
  error: string | null
  onOpen: (path: string, event: MouseEvent<HTMLButtonElement>) => void
}

function MutationChip({
  pending,
  icon,
  pendingLabel,
  verb,
  label,
  showStatistics = true,
  outcome,
  error,
  onOpen,
}: MutationChipProps): ReactElement {
  if (error !== null) {
    return (
      <ChipFrame pending={false} icon={icon}>
        {pendingLabel} — {error}
      </ChipFrame>
    )
  }
  if (outcome === null) {
    return (
      <ChipFrame pending={pending} icon={icon}>
        {pendingLabel}
      </ChipFrame>
    )
  }
  if (!outcome.ok) {
    return (
      <ChipFrame pending={false} icon={icon}>
        {pendingLabel} — {outcome.message}
      </ChipFrame>
    )
  }
  return (
    <ChipFrame pending={false} icon={icon}>
      {verb}{' '}
      <button
        type="button"
        onClick={(event) => onOpen(outcome.path, event)}
        className="underline-offset-2 hover:text-text hover:underline"
      >
        {label}
      </button>
      {showStatistics ? ` · +${outcome.addedLines} −${outcome.removedLines}` : null}
    </ChipFrame>
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
  const { navigate } = useRouter()
  const navigateNoteLink = useNoteLinkNavigation()
  const openNote = (path: string, event: MouseEvent<HTMLButtonElement>): void => {
    navigateNoteLink({ target: routeForPath(path), openInNewWindow: isModEvent(event) })
  }
  const pending = isToolPending(part)
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
        Listed daily notes {call.start} – {call.end}
        {result !== null ? countSuffix(result.days.length, 'day') : ''}
        {result !== null ? <NoteLinks notes={result.days} onOpen={openNote} /> : null}
      </ChipFrame>
    )
  }

  if (call.tool === 'edit') {
    const outcome = part.result?.tool === 'edit' ? part.result.outcome : null
    return (
      <MutationChip
        pending={pending}
        icon={<PencilLine aria-hidden className="size-3.5" />}
        pendingLabel={`Editing ${call.path}`}
        verb="Edited"
        label={call.path}
        outcome={outcome}
        error={part.error}
        onOpen={openNote}
      />
    )
  }

  if (call.tool === 'append') {
    const outcome = part.result?.tool === 'append' ? part.result.outcome : null
    return (
      <MutationChip
        pending={pending}
        icon={<PencilLine aria-hidden className="size-3.5" />}
        pendingLabel={`Appending to ${call.path}`}
        verb="Edited"
        label={call.path}
        outcome={outcome}
        error={part.error}
        onOpen={openNote}
      />
    )
  }

  if (call.tool === 'create') {
    const outcome = part.result?.tool === 'create' ? part.result.outcome : null
    return (
      <MutationChip
        pending={pending}
        icon={<FilePlus2 aria-hidden className="size-3.5" />}
        pendingLabel={`Creating ${call.title}`}
        verb="Created"
        label={call.title}
        showStatistics={false}
        outcome={outcome}
        error={part.error}
        onOpen={openNote}
      />
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
        const label = note.title ?? note.path
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
