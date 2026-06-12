import type { ReactElement, ReactNode } from 'react'
import { CalendarDays, FileText, History, Search } from 'lucide-react'
import { isToolPending, type AssistantPart } from '@reflect/core'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { Spinner } from '@/components/ui/spinner'

interface ChatToolChipProps {
  part: Extract<AssistantPart, { kind: 'tool' }>
}

/** ` · 3 notes` — the settled count suffix of a listing chip. */
function countSuffix(count: number, noun: string): string {
  return ` · ${count} ${noun}${count === 1 ? '' : 's'}`
}

interface ChipFrameProps {
  pending: boolean
  icon: ReactElement
  children: ReactNode
}

/** The shared chip shell: a spinner while pending, the tool's icon after. */
function ChipFrame({ pending, icon, children }: ChipFrameProps): ReactElement {
  return (
    <span className="flex items-center gap-1.5 text-xs text-text-muted">
      {pending ? <Spinner /> : icon}
      {children}
    </span>
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
  const pending = isToolPending(part)
  const call = part.call

  if (call.tool === 'search') {
    const result = part.result?.tool === 'search' ? part.result : null
    return (
      <ChipFrame pending={pending} icon={<Search aria-hidden className="size-3.5" />}>
        <span className="truncate">
          Searched “{call.query}”
          {result !== null ? countSuffix(result.hits.length, 'note') : ''}
        </span>
      </ChipFrame>
    )
  }

  if (call.tool === 'recents') {
    const result = part.result?.tool === 'recents' ? part.result : null
    return (
      <ChipFrame pending={pending} icon={<History aria-hidden className="size-3.5" />}>
        <span className="truncate">
          Listed {call.tag !== null ? `#${call.tag}` : 'recent'} notes
          {result !== null
            ? result.error !== null
              ? ` — ${result.error}`
              : countSuffix(result.notes.length, 'note')
            : ''}
        </span>
      </ChipFrame>
    )
  }

  if (call.tool === 'dailies') {
    const result = part.result?.tool === 'dailies' ? part.result : null
    return (
      <ChipFrame pending={pending} icon={<CalendarDays aria-hidden className="size-3.5" />}>
        <span className="truncate">
          Listed daily notes {call.start} – {call.end}
          {result !== null ? countSuffix(result.days.length, 'day') : ''}
        </span>
      </ChipFrame>
    )
  }

  const result = part.result?.tool === 'read' ? part.result : null
  const error = part.error ?? result?.error ?? null
  return (
    <ChipFrame pending={pending} icon={<FileText aria-hidden className="size-3.5" />}>
      {!pending && error === null ? (
        <button
          type="button"
          onClick={() => navigate(routeForPath(call.path))}
          className="truncate underline-offset-2 hover:text-text hover:underline"
        >
          Read {result?.title ?? call.path}
        </button>
      ) : (
        <span className="truncate">
          {call.path}
          {error !== null ? ` — ${error}` : ''}
        </span>
      )}
    </ChipFrame>
  )
}
