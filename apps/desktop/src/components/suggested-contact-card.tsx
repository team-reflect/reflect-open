import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { UserRound } from 'lucide-react'
import { suggestedContactDetails } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { useSuggestedContact } from '@/hooks/use-suggested-contact.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { cn } from '@/lib/utils.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

interface SuggestedContactCardProps {
  /** Graph-relative path of the note the card sits above. */
  path: string
  className?: string | undefined
}

/**
 * The suggested-contact card (the contacts-integration port): shown above a
 * note whose title exactly matches an Apple Contact, offering the contact's
 * primary email/phone. **Add** merges them into the note as plain markdown;
 * **Ignore** dismisses the card for this note. Either way the resolution
 * lands in the note's frontmatter, so the card never reappears — and the
 * query cache is settled optimistically so it hides without waiting for the
 * watcher round trip.
 */
export function SuggestedContactCard({
  path,
  className,
}: SuggestedContactCardProps): ReactElement | null {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const { contactSuggestions } = useCoreServices()
  const contact = useSuggestedContact(path)
  const resolveAction = useAsyncAction()

  if (contact === null) {
    return null
  }

  async function resolve(action: () => Promise<void>): Promise<void> {
    await resolveAction.run(async () => {
      await action()
      // Invalidate rather than hand-set null: the refetch reads the live
      // source, so a handled note computes null (card hides) while a stale
      // Ignore — which skipped the mark — computes the renamed title's own
      // suggestion instead of suppressing it until the next disk write.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.index.suggestedContact(graph?.root, path),
      })
    })
  }

  const details = suggestedContactDetails(contact)

  return (
    <div
      aria-label="Suggested contact"
      className={cn(
        'mb-4 flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 shadow-sm',
        className,
      )}
    >
      <UserRound aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-text-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text">{contact.fullName}</div>
        <div className="truncate text-xs text-text-muted">
          {resolveAction.error !== null ? (
            <span role="alert" className="text-red-500">
              {resolveAction.error}
            </span>
          ) : (
            details
          )}
        </div>
      </div>
      <Button
        size="xs"
        variant="ghost"
        disabled={resolveAction.pending}
        onClick={() => void resolve(() => contactSuggestions.ignore(path, contact))}
      >
        Ignore
      </Button>
      <Button
        size="xs"
        disabled={resolveAction.pending}
        onClick={() => void resolve(() => contactSuggestions.addToNote(path, contact))}
      >
        Add
      </Button>
    </div>
  )
}
