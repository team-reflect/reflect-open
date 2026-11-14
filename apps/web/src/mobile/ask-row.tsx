import type { ReactElement } from 'react'
import { ChevronRight, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import { useChatActions, useChatProviders } from '@/providers/chat-provider.tsx'
import { useRouterActions } from '@/routing/router.tsx'

interface MobileAskRowProps {
  /** The All tab's search text, asked as typed. */
  query: string
}

/**
 * The All tab's Ask row: the search text, offered as a question to Chat. It
 * sits above the results while there is text to ask. Tapping starts a fresh conversation with the question already
 * sent (or reopens the open one if it began with this question, so a second
 * tap after Back shows the same answer) and pushes Chat over All, so Back
 * returns to the same results. With no AI provider the row is muted and
 * leads to Settings, where keys are added.
 */
export function MobileAskRow({ query }: MobileAskRowProps): ReactElement | null {
  const providers = useChatProviders()
  const { ask } = useChatActions()
  const { navigate } = useRouterActions()
  const question = query.trim()
  const hasProvider = providers.length > 0

  if (question === '') {
    return null
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (hasProvider) {
          void ask(question)
          navigate({ kind: 'chat', conversationId: null })
        } else {
          navigate({ kind: 'settings', page: 'main' })
        }
      }}
      className="flex w-full shrink-0 items-center gap-3 border-b border-border bg-surface-sunken px-safe-offset-4 py-3 text-left"
    >
      <span
        aria-hidden
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg',
          hasProvider ? 'bg-primary/10 text-primary' : 'bg-surface text-text-muted',
        )}
      >
        <Sparkles className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate text-sm font-medium', !hasProvider && 'text-text-muted')}>
          Ask “{question}”
        </span>
        <span className="text-xs text-text-muted">
          {hasProvider ? 'Answer from your notes' : 'Add an AI provider in Settings to ask'}
        </span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-text-muted" />
    </button>
  )
}
