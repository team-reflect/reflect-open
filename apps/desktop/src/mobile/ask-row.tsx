import type { ReactElement } from 'react'
import { ChevronRight, Sparkles } from 'lucide-react'
import { useChatActions, useChatProviders } from '@/providers/chat-provider.tsx'
import { useRouter } from '@/routing/router.tsx'

interface MobileAskRowProps {
  /** The All tab's search text, asked as typed. */
  query: string
}

/**
 * The All tab's Ask row: the search text, offered as a question to Chat. It
 * sits above the results while there is text to ask and an AI provider to
 * ask it of. Tapping starts a fresh conversation with the question already
 * sent (or reopens the open one if it began with this question, so a second
 * tap after Back shows the same answer) and pushes Chat over All, so Back
 * returns to the same results.
 */
export function MobileAskRow({ query }: MobileAskRowProps): ReactElement | null {
  const providers = useChatProviders()
  const { ask } = useChatActions()
  const { navigate } = useRouter()
  const question = query.trim()

  if (question === '' || providers.length === 0) {
    return null
  }

  return (
    <button
      type="button"
      onClick={() => {
        void ask(question)
        navigate({ kind: 'chat' })
      }}
      className="flex w-full shrink-0 items-center gap-3 border-b border-border bg-surface-sunken px-safe-offset-4 py-3 text-left"
    >
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
      >
        <Sparkles className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">Ask “{question}”</span>
        <span className="text-xs text-text-muted">Answer from your notes</span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-text-muted" />
    </button>
  )
}
