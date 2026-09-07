import { useMemo, useState, type ReactElement } from 'react'
import { FileDiff, RotateCcw } from 'lucide-react'
import type { ChatNoteChange } from '@reflect/core'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/components/ui/drawer'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation'
import { isMobileSurface } from '@/lib/platform-surface'
import { routeForPath } from '@/routing/route'
import { ChatChangeDiff } from './chat-change-diff'
import { groupChatNoteChanges, type ChatNoteChangeGroup } from './chat-change-groups'

interface ChatChangeSummaryProps {
  changes: readonly ChatNoteChange[]
  onUndoTurn: () => Promise<void>
  onUndoPath: (path: string) => Promise<void>
}

/** Turn-level changed-note summary, review surface, and guarded Undo controls. */
export function ChatChangeSummary({
  changes,
  onUndoTurn,
  onUndoPath,
}: ChatChangeSummaryProps): ReactElement | null {
  const groups = useMemo(() => groupChatNoteChanges(changes), [changes])
  const [reviewOpen, setReviewOpen] = useState(false)
  const [pendingUndo, setPendingUndo] = useState<string | null>(null)
  const [undoError, setUndoError] = useState<string | null>(null)
  if (groups.length === 0) {
    return null
  }

  const addedLines = groups.reduce((total, group) => total + group.addedLines, 0)
  const removedLines = groups.reduce((total, group) => total + group.removedLines, 0)
  const applied = groups.some((group) => group.state === 'applied')
  const allUndone = groups.every((group) => group.state === 'undone')
  const needsReview = groups.some((group) => group.state === 'uncertain')

  const undo = async (key: string, action: () => Promise<void>): Promise<void> => {
    setPendingUndo(key)
    setUndoError(null)
    try {
      await action()
    } catch (cause) {
      setUndoError(cause instanceof Error ? cause.message : 'The change could not be undone.')
      setReviewOpen(true)
    } finally {
      setPendingUndo(null)
    }
  }

  const review = (
    <ChatChangeReview
      groups={groups}
      pendingUndo={pendingUndo}
      undoError={undoError}
      onUndo={(group) => undo(group.path, async () => await onUndoPath(group.path))}
    />
  )

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
      <FileDiff aria-hidden className="size-3.5" />
      <span>
        {needsReview ? 'Review needed for' : allUndone ? 'Undid changes to' : 'Changed'}{' '}
        {groups.length} {groups.length === 1 ? 'note' : 'notes'}
        {!allUndone ? ` · +${addedLines} −${removedLines}` : ''}
      </span>
      <Button variant="ghost" size="xs" onClick={() => setReviewOpen(true)}>
        Review
      </Button>
      {applied ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={pendingUndo !== null}
          onClick={() => void undo('__turn__', onUndoTurn)}
        >
          <RotateCcw aria-hidden />
          Undo
        </Button>
      ) : null}

      {isMobileSurface() ? (
        <Drawer open={reviewOpen} onOpenChange={setReviewOpen}>
          <DrawerContent
            className="[--drawer-content-height:100dvh] [--drawer-content-max-height:100dvh]"
            aria-label="Review note changes"
          >
            <DrawerTitle>Note changes</DrawerTitle>
            <DrawerDescription>Markdown changes made by this chat turn.</DrawerDescription>
            {review}
          </DrawerContent>
        </Drawer>
      ) : (
        <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
          <DialogContent className="max-h-[85dvh] sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Note changes</DialogTitle>
              <DialogDescription>Markdown changes made by this chat turn.</DialogDescription>
            </DialogHeader>
            {review}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

interface ChatChangeReviewProps {
  groups: readonly ChatNoteChangeGroup[]
  pendingUndo: string | null
  undoError: string | null
  onUndo: (group: ChatNoteChangeGroup) => Promise<void>
}

function ChatChangeReview({
  groups,
  pendingUndo,
  undoError,
  onUndo,
}: ChatChangeReviewProps): ReactElement {
  const navigateNoteLink = useNoteLinkNavigation()

  return (
    <div className="min-h-0 space-y-5 overflow-y-auto pb-2">
      {undoError !== null ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {undoError}
        </p>
      ) : null}
      {groups.map((group) => (
        <section key={group.path} className="space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left font-medium underline-offset-2 hover:underline"
              onClick={() =>
                navigateNoteLink({ target: routeForPath(group.path), openInNewWindow: false })
              }
            >
              {group.title}
            </button>
            <span className="shrink-0 text-xs text-text-muted">
              {group.state === 'undone'
                ? 'Undone'
                : group.state === 'uncertain'
                  ? 'Review needed'
                  : `+${group.addedLines} −${group.removedLines}`}
            </span>
            {group.state === 'applied' ? (
              <Button
                variant="outline"
                size="xs"
                aria-label={`Undo changes to ${group.title}`}
                disabled={pendingUndo !== null}
                onClick={() => void onUndo(group)}
              >
                <RotateCcw aria-hidden />
                Undo
              </Button>
            ) : null}
          </div>
          <ChatChangeDiff
            path={group.path}
            beforeSource={group.beforeSource}
            afterSource={group.afterSource}
          />
        </section>
      ))}
    </div>
  )
}
