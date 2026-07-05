import { useState, type ReactElement } from 'react'
import {
  ArrowRight,
  CalendarDays,
  Check,
  CircleCheck,
  List,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import type { OpenTask } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { addDaysIso, formatDayLabel } from '@/lib/dates'
import { taskContent, resolveTaskEdit } from '@/lib/tasks/task-content'
import type { TaskActions } from '@/lib/tasks/use-task-actions'
import { cn } from '@/lib/utils'
import { hapticImpactLight } from '@/mobile/haptics'
import { draftDueDate, withDraftDueDate } from '@/mobile/task-draft'
import { TaskScheduleGrid } from '@/mobile/task-schedule-grid'
import { useSettings } from '@/providers/settings-provider'

interface MobileTaskEditSheetProps {
  /** The task being edited. Remount (key by task) to reseed the draft. */
  task: OpenTask
  open: boolean
  /** Close the sheet. A user dismissal commits the draft first (V1 mobile). */
  onOpenChange: (open: boolean) => void
  /** Today's live ISO date, for the schedule shortcuts and the month grid. */
  today: string
  /** The screen's shared task actions — one optimistic-cache path for every write. */
  actions: TaskActions
  /** Navigate to the task's source note (the sheet commits the draft first). */
  onOpenNote: (notePath: string) => void
}

/**
 * The quick-edit bottom sheet (V1 mobile's edit modal over Plan 18 data): edit
 * a task's text, schedule it, complete it, or jump to its source note — without
 * opening the note. The draft is markdown (links and tags intact) and due-date
 * changes edit the draft's `[[YYYY-MM-DD]]` link in place, so everything lands
 * as **one** write when the sheet closes: dismissing commits a changed draft,
 * an emptied draft deletes the task (V1's empty-task rule via
 * {@link resolveTaskEdit}), and an untouched draft writes nothing. The action
 * buttons route through the same {@link TaskActions} the desktop view uses —
 * save-then-act, never a racing second write path.
 */
export function MobileTaskEditSheet({
  task,
  open,
  onOpenChange,
  today,
  actions,
  onOpenNote,
}: MobileTaskEditSheetProps): ReactElement {
  const { settings } = useSettings()
  const liveContent = taskContent(task.raw)
  // The edit baseline is frozen at open (desktop's inline editor does the
  // same at mount): `task` is the live row, and if a reindex rewrites it while
  // the sheet is up, comparing the untouched draft against the *new* content
  // would read as an edit and commit stale text over the external change.
  const [initial, setInitial] = useState(liveContent)
  const [draft, setDraft] = useState(liveContent)
  const [showCalendar, setShowCalendar] = useState(false)
  // Set once an action button has already written/closed, so the dismissal
  // commit doesn't double-write on the close that follows.
  const [handled, setHandled] = useState(false)
  // The sheet stays mounted after closing (the exit animation needs content),
  // so re-opening it for the same task must reseed everything: the baseline
  // and draft from the row's current raw (an action may have rewritten it),
  // the calendar collapsed, and the handled flag cleared — else a visit after
  // Complete/Convert/Open note would silently drop its edits on dismiss.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setHandled(false)
      setInitial(liveContent)
      setDraft(liveContent)
      setShowCalendar(false)
    }
  }
  const dueDate = draftDueDate(draft)

  const close = (): void => {
    setHandled(true)
    onOpenChange(false)
  }

  /** Persist the draft: a real change commits, an emptied draft deletes. */
  const commitDraft = (): void => {
    const result = resolveTaskEdit(initial, draft)
    if (result.type === 'commit') {
      actions.edit(task, result.content)
    } else if (result.type === 'delete') {
      actions.remove([task])
    }
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && !handled) {
      // Dismissal (drag down / tap outside) additionally treats a task that
      // was already empty and stayed empty — a "+"-added row abandoned
      // without typing — as a delete, so no bare `+ [ ]` ghosts in the note
      // (V1's empty-task rule, desktop's editor-finalizer auto-delete).
      // Only here: "Open note" on an untouched empty task must not delete
      // the very line it navigates to.
      if (resolveTaskEdit(initial, draft).type === 'cancel' && draft.trim() === '') {
        actions.remove([task])
      } else {
        commitDraft()
      }
    }
    onOpenChange(nextOpen)
  }

  const complete = (): void => {
    hapticImpactLight()
    const result = resolveTaskEdit(initial, draft)
    if (result.type === 'commit') {
      actions.editAndToggle(task, result.content)
    } else if (result.type === 'delete') {
      // Emptied then completed: delete, like desktop's ⌘↵ on an emptied row —
      // never toggle text the user just cleared back into the note.
      actions.remove([task])
    } else {
      actions.checkboxToggle(task)
    }
    close()
  }

  const convertToBullet = (): void => {
    const result = resolveTaskEdit(initial, draft)
    if (result.type === 'commit') {
      actions.editAndConvertToBullet(task, result.content)
    } else if (result.type === 'delete') {
      // Emptied then converted: delete, like desktop's ⌘⇧K on an emptied row —
      // converting would resurrect the cleared text as a bullet.
      actions.remove([task])
    } else {
      actions.convertToBullet([task])
    }
    close()
  }

  const openNote = (): void => {
    commitDraft()
    close()
    onOpenNote(task.notePath)
  }

  const remove = (): void => {
    actions.remove([task])
    close()
  }

  const schedule = (isoDate: string | null): void => {
    setDraft((current) => withDraftDueDate(current, isoDate))
    setShowCalendar(false)
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent aria-label="Edit task">
        <DrawerTitle className="sr-only">Edit task</DrawerTitle>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={2}
          aria-label="Task text"
          // Touch-surface hygiene, like the note editor: no autocap/autocorrect
          // rewriting markdown syntax under the user.
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-base leading-6 text-text outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Schedule">
          <ScheduleChip
            label="Today"
            active={dueDate === today}
            onClick={() => schedule(today)}
          />
          <ScheduleChip
            label="Tomorrow"
            active={dueDate === addDaysIso(today, 1)}
            onClick={() => schedule(addDaysIso(today, 1))}
          />
          <ScheduleChip
            label="Next week"
            active={dueDate === addDaysIso(today, 7)}
            onClick={() => schedule(addDaysIso(today, 7))}
          />
          <ScheduleChip
            label={
              dueDate !== null ? formatDayLabel(dueDate, settings.dateFormat) : 'Pick date'
            }
            icon={<CalendarDays aria-hidden className="size-3.5" />}
            active={showCalendar}
            onClick={() => setShowCalendar((showing) => !showing)}
          />
          {dueDate !== null ? (
            <ScheduleChip
              label="Clear"
              icon={<X aria-hidden className="size-3.5" />}
              active={false}
              onClick={() => schedule(null)}
            />
          ) : null}
        </div>
        {showCalendar ? (
          <TaskScheduleGrid today={today} selected={dueDate} onPick={schedule} />
        ) : null}
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <Button
            variant="ghost"
            size="lg"
            className="h-12 justify-start gap-3 text-base"
            onClick={complete}
          >
            {task.checked ? <Undo2 /> : <CircleCheck />}
            {task.checked ? 'Reopen' : 'Complete'}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="h-12 justify-start gap-3 text-base"
            onClick={convertToBullet}
          >
            <List />
            Convert to bullet
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="h-12 justify-start gap-3 text-base"
            onClick={openNote}
          >
            <ArrowRight />
            Open note
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="h-12 justify-start gap-3 text-base text-destructive hover:text-destructive"
            onClick={remove}
          >
            <Trash2 />
            Delete
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function ScheduleChip({
  label,
  icon,
  active,
  onClick,
}: {
  label: string
  icon?: ReactElement
  active: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-8 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-xs font-medium',
        active
          ? 'border-accent/40 bg-accent-soft text-text'
          : 'border-border text-text-muted',
      )}
    >
      {active && icon === undefined ? <Check aria-hidden className="size-3.5" /> : icon}
      {label}
    </button>
  )
}
