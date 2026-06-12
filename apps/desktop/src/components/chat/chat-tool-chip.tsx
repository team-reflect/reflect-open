import type { ReactElement } from 'react'
import { FileText, LoaderCircle, Search } from 'lucide-react'
import { isToolPending, type AssistantPart } from '@/lib/chat-transcript'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'

interface ChatToolChipProps {
  part: Extract<AssistantPart, { kind: 'tool' }>
}

/**
 * The transparent-context chip for one tool call: what the assistant searched
 * for (and how many notes came back), or which note it read. Successful read
 * chips click through to the note; a refused or failed read shows the
 * failure instead of pretending the note was used. This is the only UI that
 * knows tool names — new tools extend `tools.ts` and this switch.
 */
export function ChatToolChip({ part }: ChatToolChipProps): ReactElement {
  const { navigate } = useRouter()
  const pending = isToolPending(part)
  const call = part.call

  if (call.tool === 'search') {
    const result = part.result?.tool === 'search' ? part.result : null
    return (
      <span className="flex items-center gap-1.5 text-xs text-text-muted">
        {pending ? (
          <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <Search aria-hidden className="size-3.5" />
        )}
        <span className="truncate">
          Searched “{call.query}”
          {result !== null
            ? ` · ${result.hits.length} ${result.hits.length === 1 ? 'note' : 'notes'}`
            : ''}
        </span>
      </span>
    )
  }

  const result = part.result?.tool === 'read' ? part.result : null
  const error = part.error ?? result?.error ?? null
  return (
    <span className="flex items-center gap-1.5 text-xs text-text-muted">
      {pending ? (
        <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
      ) : (
        <FileText aria-hidden className="size-3.5" />
      )}
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
    </span>
  )
}
