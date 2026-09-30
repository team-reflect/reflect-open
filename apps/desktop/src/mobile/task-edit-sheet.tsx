import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import { ArrowRight, CalendarDays, Check, CircleCheck, List, Trash2, Undo2, X } from 'lucide-react'
import { Priority, getIsComposing } from '@meowdown/core'
import { useKeymap } from '@meowdown/react'
import type { Task } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer.tsx'
import { markModeFromSyntax } from '@/editor/mark-mode.ts'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor.tsx'
import { useEditorAutocomplete } from '@/editor/use-editor-autocomplete.ts'
import { useTagNavigation } from '@/editor/use-tag-navigation.ts'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation.ts'
import { addDaysIso, formatDayLabel } from '@/lib/dates.ts'
import { useTaskStore } from '@/lib/tasks/task-store.ts'
import { cn } from '@/lib/utils.ts'
import { hapticImpactLight } from '@/mobile/haptics.ts'
import { TaskScheduleGrid } from '@/mobile/task-schedule-grid.tsx'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'

interface MobileTaskEditSheetProps {
  /** The task being edited, as the task store currently shows it. */
  task: Task
  open: boolean
  /** Close the sheet. A user dismissal saves the draft first (V1 mobile). */
  onOpenChange: (open: boolean) => void
  /** Today's live ISO date, for the schedule shortcuts and the month grid. */
  today: string
  /** Navigate to the task's source note (the sheet saves the draft first). */
  onOpenNote: (notePath: string) => void
  /**
   * Focus the editor (raising the keyboard) as soon as the sheet opens: the
   * "+"-add flow, where the task is brand new and typing is the next step.
   * Row taps leave focus alone so the action list stays visible.
   */
  autoFocusEditor?: boolean
}

/**
 * The quick-edit bottom sheet (V1 mobile's edit modal): edit a task's text,
 * schedule it, complete it, or jump to its source note without opening the
 * note. The text is desktop's inline task editor surface over the same task
 * store: keystrokes go to the store's draft, and dismissing the
 * sheet, tapping an action, or following a link saves it. An emptied draft
 * deletes the task, and an untouched draft writes nothing.
 */
export function MobileTaskEditSheet({
  task,
  open,
  onOpenChange,
  today,
  onOpenNote,
  autoFocusEditor = false,
}: MobileTaskEditSheetProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const navigateWikiLink = useWikiLinkNavigation(graph?.generation ?? null)
  const navigateTag = useTagNavigation()
  const { onWikilinkSearch, onTagSearch } = useEditorAutocomplete()
  const store = useTaskStore()
  const [showCalendar, setShowCalendar] = useState(false)
  // The editor is uncontrolled and the sheet stays mounted while closed (the
  // exit animation needs its content), so reopening remounts the editor with
  // the task's current text, and so does a schedule that rewrote the text.
  const [editorSeed, setEditorSeed] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setShowCalendar(false)
      setEditorSeed((seed) => seed + 1)
    }
  }
  const editorRef = useRef<NoteEditorHandle | null>(null)
  const handleEditorRef = useCallback(
    (handle: NoteEditorHandle | null) => {
      editorRef.current = handle
      if (handle !== null && autoFocusEditor) handle.focus()
    },
    [autoFocusEditor],
  )

  // A route change can unmount the open sheet without a dismissal: save the
  // draft then too. An application flush saves it through the store itself.
  const latest = useRef({ task, store, open })
  useLayoutEffect(() => {
    latest.current = { task, store, open }
  })
  useEffect(
    () => () => {
      if (latest.current.open) latest.current.store?.commitDraft(latest.current.task)
    },
    [],
  )

  // Every way out of the sheet saves the draft first.
  const close = (): void => {
    store?.commitDraft(task)
    onOpenChange(false)
  }
  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) onOpenChange(true)
    else close()
  }
  const finishEdit = useCallback(() => {
    latest.current.store?.commitDraft(latest.current.task)
    onOpenChange(false)
  }, [onOpenChange])

  const complete = (): void => {
    hapticImpactLight()
    store?.update(task, { checked: !store.current(task).checked })
    close()
  }
  const convertToBullet = (): void => {
    hapticImpactLight()
    store?.update(task, { gone: 'bullet' })
    close()
  }
  const remove = (): void => {
    hapticImpactLight()
    store?.update(task, { gone: 'removed' })
    close()
  }
  const openNote = (): void => {
    hapticImpactLight()
    close()
    onOpenNote(task.notePath)
  }
  // A link tapped inside the draft navigates like "Open note".
  const openWikiLink = ({ target }: { target: string }): void => {
    close()
    navigateWikiLink({ target, openInNewWindow: false })
  }
  const openTag = (tag: string): void => {
    close()
    navigateTag(tag)
  }
  const schedule = (isoDate: string | null): void => {
    hapticImpactLight()
    store?.update(task, { dueDate: isoDate })
    setShowCalendar(false)
    setEditorSeed((seed) => seed + 1)
  }
  const toggleCalendar = (): void => {
    hapticImpactLight()
    setShowCalendar((showing) => !showing)
  }
  const dueDate = task.dueDate

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent
        aria-label="Edit task"
        // On the "+"-add path the editor takes focus instead of the sheet
        // container, so typing can start immediately.
        initialFocus={() => {
          if (!autoFocusEditor) {
            return true
          }
          editorRef.current?.focus()
          return false
        }}
      >
        <DrawerTitle className="sr-only">Edit task</DrawerTitle>
        <div className="flex flex-col gap-3 p-4">
          <div
            data-base-ui-swipe-ignore
            className="rounded-md border border-border bg-surface px-3 py-2 focus-within:ring-1 focus-within:ring-accent"
          >
            <NoteEditor
              key={editorSeed}
              initialContent={task.text}
              singleParagraph
              onChange={(markdown) => store?.draft(task, markdown)}
              markMode={markModeFromSyntax(settings.editorMarkdownSyntax)}
              spellCheck={settings.editorSpellCheck}
              smoothCaretAnimation={settings.editorSmoothCaretAnimation}
              timeFormat={settings.timeFormat}
              blockHandle={false}
              onWikiLinkClick={openWikiLink}
              onTagClick={openTag}
              onWikilinkSearch={onWikilinkSearch}
              onTagSearch={onTagSearch}
              className="reflect-task-editor min-h-12 text-base"
              handleRef={handleEditorRef}
            >
              <TaskSheetKeymap onDone={finishEdit} />
            </NoteEditor>
          </div>
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
              label={dueDate !== null ? formatDayLabel(dueDate, settings.dateFormat) : 'Pick date'}
              icon={<CalendarDays aria-hidden className="size-3.5" />}
              active={showCalendar}
              onClick={toggleCalendar}
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
        </div>
      </DrawerContent>
    </Drawer>
  )
}

/**
 * Enter finishes the edit: a task is one line, so a new block is never the
 * right outcome. Bound at high priority inside the editor's ProseKit context;
 * the `[[` and `#` menus still claim Enter first while open.
 */
function TaskSheetKeymap({ onDone }: { onDone: () => void }): null {
  const keymap = useMemo(
    () => ({
      Enter: () => {
        if (getIsComposing()) return false
        onDone()
        return true
      },
    }),
    [onDone],
  )
  useKeymap(keymap, { priority: Priority.high })
  return null
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
        active ? 'border-accent/40 bg-accent-soft text-text' : 'border-border text-text-muted',
      )}
    >
      {active && icon === undefined ? <Check aria-hidden className="size-3.5" /> : icon}
      {label}
    </button>
  )
}
