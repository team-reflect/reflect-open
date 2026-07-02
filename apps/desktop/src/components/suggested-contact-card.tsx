import { useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { UserRound } from 'lucide-react'
import { errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { suggestedContactQueryKey, useSuggestedContact } from '@/hooks/use-suggested-contact'
import { addContactToNote, ignoreContactSuggestion } from '@/lib/note-contact'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'

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
export function SuggestedContactCard({ path, className }: SuggestedContactCardProps): ReactElement | null {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const contact = useSuggestedContact(path)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = graph?.generation ?? null

  if (contact === null || generation === null) {
    return null
  }

  async function resolve(action: () => Promise<void>): Promise<void> {
    setIsBusy(true)
    setError(null)
    try {
      await action()
      // Invalidate rather than hand-set null: the refetch reads the live
      // source, so a handled note computes null (card hides) while a stale
      // Ignore — which skipped the mark — computes the renamed title's own
      // suggestion instead of suppressing it until the next disk write.
      await queryClient.invalidateQueries({
        queryKey: suggestedContactQueryKey(graph?.root, path),
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setIsBusy(false)
    }
  }

  const details = [contact.emails[0], contact.phones[0]]
    .filter((value): value is string => value !== undefined && value.trim() !== '')
    .join(' · ')

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
          {error !== null ? (
            <span role="alert" className="text-red-500">
              {error}
            </span>
          ) : (
            details
          )}
        </div>
      </div>
      <Button
        size="xs"
        variant="ghost"
        disabled={isBusy}
        onClick={() => void resolve(() => ignoreContactSuggestion(path, contact, generation))}
      >
        Ignore
      </Button>
      <Button
        size="xs"
        disabled={isBusy}
        onClick={() => void resolve(() => addContactToNote(path, contact, generation))}
      >
        Add
      </Button>
    </div>
  )
}
