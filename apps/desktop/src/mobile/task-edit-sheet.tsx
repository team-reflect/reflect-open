import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
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
import { Priority } from '@meowdown/core'
import { useKeymap } from '@meowdown/react'
import type { OpenTask } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { markModeFromSyntax } from '@/editor/mark-mode'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor'
import { useEditorAutocomplete } from '@/editor/use-editor-autocomplete'
import { useTagNavigation } from '@/editor/use-tag-navigation'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation'
import { addDaysIso, formatDayLabel } from '@/lib/dates'
import type { TaskActions } from '@/lib/tasks/use-task-actions'
import { cn } from '@/lib/utils'
import { hapticImpactLight } from '@/mobile/haptics'
import { draftDueDate, withDraftDueDate } from '@/mobile/task-draft'
import { TaskScheduleGrid } from '@/mobile/task-schedule-grid'
import { useTaskSheetFinalizer } from '@/mobile/use-task-sheet-finalizer'
import { useGraph } from '@/providers/graph-provider'
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
  /**
   * Focus the editor (raising the keyboard) as soon as the sheet opens — the
   * "+"-add flow, where the task is brand new and typing is the next step.
   * Row taps leave focus alone so the action list stays visible.
   */
  autoFocusEditor?: boolean
}

/**
 * The quick-edit bottom sheet (V1 mobile's edit modal over Plan 18 data): edit
 * a task's text, schedule it, complete it, or jump to its source note — without
 * opening the note. The text is desktop's inline task editor surface — the real
 * {@link NoteEditor}, with meowdown's `[[`/`#` menus and clickable links — over
 * the same markdown draft, and due-date changes edit the draft's
 * `[[YYYY-MM-DD]]` link in place, so everything lands as **one** write when the
 * sheet closes: dismissing commits a changed draft, an emptied draft deletes
 * the task, and an untouched draft writes nothing — the exit rules live in
 * {@link useTaskSheetFinalizer}. The action buttons route through the same
 * {@link TaskActions} the desktop view uses — save-then-act, never a racing
 * second write path.
 */
export function MobileTaskEditSheet({
  task,
  open,
  onOpenChange,
  today,
  actions,
  onOpenNote,
  autoFocusEditor = false,
}: MobileTaskEditSheetProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const generation = graph?.generation ?? null
  const navigateWikiLink = useWikiLinkNavigation(generation)
  const navigateTag = useTagNavigation()
  const { onWikilinkSearch, onTagSearch } = useEditorAutocomplete()
  const [showCalendar, setShowCalendar] = useState(false)
  // The editor is uncontrolled; a reopen reseeds the draft (the row may have
  // been rewritten by an action), so remount it via this seed to re-read it.
  const [editorSeed, setEditorSeed] = useState(0)
  const editorRef = useRef<NoteEditorHandle | null>(null)
  // The editor's live markdown, mirrored from its own onChange stream (the
  // desktop task editor's currentRef pattern) so an edit the state hasn't
  // re-rendered yet is never dropped or clobbered. Tagged with the editor
  // instance: after a reseed remount the previous instance's leftovers read
  // as null. Never an imperative getMarkdown() — that coalesces "not ready"
  // and "torn down" into '', indistinguishable from a genuine clear, and an
  // empty draft means delete.
  const liveDraftRef = useRef<{ seed: number; markdown: string } | null>(null)
  const readLiveDraft = (): string | null =>
    liveDraftRef.current !== null && liveDraftRef.current.seed === editorSeed
      ? liveDraftRef.current.markdown
      : null
  // The commit/cancel/delete rules — baseline frozen at open, reseed on
  // reopen, dismissal vs navigate vs unmount — live in the finalizer. It
  // resolves against the live mirror (readDraft) with the state as fallback.
  const { draft, setDraft, resolve, handleOpenChange, closeHandled, closeNavigate } =
    useTaskSheetFinalizer({
      task,
      open,
      onOpenChange,
      actions,
      readDraft: readLiveDraft,
      onReseed: () => {
        setShowCalendar(false)
        setEditorSeed((seed) => seed + 1)
      },
    })
  const dueDate = draftDueDate(draft)

  const handleChange = (markdown: string): void => {
    liveDraftRef.current = { seed: editorSeed, markdown }
    setDraft(markdown)
  }
  // Stable while the editor is mounted: the flag only changes between visits
  // (the screen sets it before opening), never mid-edit, so the ref callback
  // can depend on it without re-attach churn.
  const handleEditorRef = useCallback(
    (handle: NoteEditorHandle | null) => {
      editorRef.current = handle
      if (handle !== null && autoFocusEditor) {
        handle.focus()
      }
    },
    [autoFocusEditor],
  )

  // Enter finishes the visit exactly like a dismissal (commit / delete-empty),
  // read through a latest-closure ref so the keymap binds once.
  const finishRef = useRef<() => void>(() => {})
  useEffect(() => {
    finishRef.current = () => handleOpenChange(false)
  })
  const finishEdit = useCallback(() => finishRef.current(), [])

  const complete = (): void => {
    hapticImpactLight()
    const result = resolve()
    if (result.type === 'commit') {
      actions.editAndToggle(task, result.content)
    } else if (result.type === 'delete') {
      // Emptied then completed: delete, like desktop's ⌘↵ on an emptied row —
      // never toggle text the user just cleared back into the note.
      actions.remove([task])
    } else {
      actions.checkboxToggle(task)
    }
    closeHandled()
  }

  const convertToBullet = (): void => {
    hapticImpactLight()
    const result = resolve()
    if (result.type === 'commit') {
      actions.editAndConvertToBullet(task, result.content)
    } else if (result.type === 'delete') {
      // Emptied then converted: delete, like desktop's ⌘⇧K on an emptied row —
      // converting would resurrect the cleared text as a bullet.
      actions.remove([task])
    } else {
      actions.convertToBullet([task])
    }
    closeHandled()
  }

  const openNote = (): void => {
    hapticImpactLight()
    closeNavigate()
    onOpenNote(task.notePath)
  }

  // A link tapped *inside* the draft navigates like "Open note": commit the
  // draft first, then resolve the target (the shared editor hooks).
  const openWikiLink = (target: string): void => {
    closeNavigate()
    navigateWikiLink(target)
  }

  const openTag = (tag: string): void => {
    closeNavigate()
    navigateTag(tag)
  }

  const remove = (): void => {
    hapticImpactLight()
    actions.remove([task])
    closeHandled()
  }

  const schedule = (isoDate: string | null): void => {
    hapticImpactLight()
    // Base the rewrite on the freshest draft, then keep every mirror in step
    // by hand: setMarkdown is silent (no onChange echo), so neither the live
    // mirror nor the state (chip highlights) updates on its own.
    const next = withDraftDueDate(readLiveDraft() ?? draft, isoDate)
    liveDraftRef.current = { seed: editorSeed, markdown: next }
    setDraft(next)
    editorRef.current?.setMarkdown(next)
    setShowCalendar(false)
  }

  const toggleCalendar = (): void => {
    hapticImpactLight()
    setShowCalendar((showing) => !showing)
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent
        aria-label="Edit task"
        // On the "+"-add path the editor takes focus instead of the sheet
        // container, so typing can start immediately.
        onOpenAutoFocus={(event) => {
          if (autoFocusEditor) {
            event.preventDefault()
            editorRef.current?.focus()
          }
        }}
      >
        <DrawerTitle className="sr-only">Edit task</DrawerTitle>
        {/* vaul must not turn a drag inside the editor (text selection) into a
            sheet drag. */}
        <div
          data-vaul-no-drag
          className="rounded-md border border-border bg-surface px-3 py-2 focus-within:ring-1 focus-within:ring-accent"
        >
          <NoteEditor
            key={editorSeed}
            initialContent={draft}
            onChange={handleChange}
            markMode={markModeFromSyntax(settings.editorMarkdownSyntax)}
            spellCheck={settings.editorSpellCheck}
            smoothCaretAnimation={settings.editorSmoothCaretAnimation}
            timeFormat={settings.timeFormat}
            // A one-line editor has nothing to reorder, so keep the gutter grip off.
            blockHandle={false}
            onWikiLinkClick={openWikiLink}
            onTagClick={openTag}
            onWikilinkSearch={onWikilinkSearch}
            onTagSearch={onTagSearch}
            className="reflect-task-editor min-h-12 text-base leading-6"
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
            label={
              dueDate !== null ? formatDayLabel(dueDate, settings.dateFormat) : 'Pick date'
            }
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
      </DrawerContent>
    </Drawer>
  )
}

/**
 * Enter (and Shift-Enter) finishes the edit — a task is one line, so a new
 * block is never the right outcome. Bound at high priority inside the editor's
 * ProseKit context, but the `[[`/`#` menus still claim Enter first while open,
 * so accepting a suggestion never closes the sheet.
 */
function TaskSheetKeymap({ onDone }: { onDone: () => void }): null {
  const keymap = useMemo(
    () => ({
      Enter: () => {
        onDone()
        return true
      },
      'Shift-Enter': () => {
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
