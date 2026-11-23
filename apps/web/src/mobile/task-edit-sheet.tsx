import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowRight, CalendarDays, Check, CircleCheck, List, Trash2, Undo2, X } from 'lucide-react'
import { Priority } from '@meowdown/core'
import { useKeymap } from '@meowdown/react'
import { Button } from '@/components/ui/button.tsx'
import { Drawer, DrawerContent, DrawerTitle } from '@/mobile/scroll-drawer.tsx'
import { markModeFromSyntax } from '@/editor/mark-mode.ts'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor.tsx'
import { useEditorAutocomplete } from '@/editor/use-editor-autocomplete.ts'
import { useTagNavigation } from '@/editor/use-tag-navigation.ts'
import { useMarkdownLinkClick } from '@/editor/use-markdown-link-click.ts'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation.ts'
import { addDaysToIsoDate } from '@reflect/utils'
import { getTaskDueDate, type OpenTask, withDraftDueDate, formatDayLabel } from '@reflect/core'
import { useTaskDraft } from '@/lib/tasks/use-task-draft.ts'
import { cn } from '@/lib/utils.ts'
import { hapticImpactLight } from '@/mobile/haptics.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'
import {
  useDateFormat,
  useEditorMarkdownSyntax,
  useEditorSmoothCaretAnimation,
  useEditorSpellCheck,
  useTimeFormat,
} from '@/providers/settings-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { noop } from '@ocavue/utils'

interface MobileTaskEditSheetProps {
  /** The task being edited. Remount (key by task) to reseed the draft. */
  task: OpenTask
  open: boolean
  /** Close the sheet. A user dismissal saves the typed text first (V1 mobile). */
  onOpenChange: (open: boolean) => void
  /** Today's live ISO date, for the schedule shortcuts. */
  today: string
  /** Navigate to the task's source note (the sheet saves the typed text first). */
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
 * `[[YYYY-MM-DD]]` link in place. The draft goes to the task commands, so
 * everything lands as **one** write: closing the sheet saves changed text,
 * removes a task whose text was cleared, drops a new task left empty, and
 * writes nothing for untouched text. The action buttons send the same
 * commands as the desktop view, and each saves the typed text in its write.
 */
export function MobileTaskEditSheet({
  task,
  open,
  onOpenChange,
  today,
  onOpenNote,
  autoFocusEditor = false,
}: MobileTaskEditSheetProps): ReactElement {
  const { haptics } = useMobileServices()
  const dateFormat = useDateFormat()
  const timeFormat = useTimeFormat()
  const editorMarkdownSyntax = useEditorMarkdownSyntax()
  const editorSpellCheck = useEditorSpellCheck()
  const editorSmoothCaretAnimation = useEditorSmoothCaretAnimation()
  const navigateWikiLink = useWikiLinkNavigation()
  const onLinkClick = useMarkdownLinkClick(null)
  const navigateTag = useTagNavigation()
  const { onWikilinkSearch, onTagSearch } = useEditorAutocomplete()
  const { commands } = useCoreServices().tasks
  const setTaskDraft = useTaskDraft(task)
  // The editor is uncontrolled, and the sheet stays mounted after it closes:
  // a reopen takes the row's current Markdown and remounts the editor.
  const [draft, setDraft] = useState(task.markdown)
  const [editorSeed, setEditorSeed] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setDraft(task.markdown)
      setEditorSeed((seed) => seed + 1)
    }
  }
  const editorRef = useRef<NoteEditorHandle | null>(null)
  // The editor's latest Markdown, ahead of the `draft` state by one render.
  // It is tagged with the editor instance, so the text of an earlier visit
  // reads as absent.
  const liveDraftRef = useRef<{ seed: number; markdown: string } | null>(null)
  const dueDate = getTaskDueDate(draft)

  const changeDraft = (markdown: string): void => {
    liveDraftRef.current = { seed: editorSeed, markdown }
    setDraft(markdown)
    setTaskDraft(markdown)
  }
  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      void commands.commit(task)
    }
    onOpenChange(nextOpen)
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

  // Enter finishes the visit exactly like a dismissal, read through a
  // latest-closure ref so the keymap binds once.
  const finishRef = useRef<() => void>(noop)
  useEffect(() => {
    finishRef.current = () => handleOpenChange(false)
  })
  const finishEdit = useCallback(() => finishRef.current(), [])

  const complete = (): void => {
    hapticImpactLight(haptics)
    void commands.toggle([task])
    onOpenChange(false)
  }

  const convertToBullet = (): void => {
    hapticImpactLight(haptics)
    void commands.convert([task])
    onOpenChange(false)
  }

  const closeToNavigate = (): void => {
    void commands.commit(task)
    onOpenChange(false)
  }

  const openNote = (): void => {
    hapticImpactLight(haptics)
    closeToNavigate()
    onOpenNote(task.notePath)
  }

  // A link tapped inside the draft navigates like "Open note": save the typed
  // text first, then resolve the target (the shared editor hooks).
  const openWikiLink = ({ target }: { target: string }): void => {
    closeToNavigate()
    navigateWikiLink({ target, openInNewWindow: false })
  }

  const openTag = (tag: string): void => {
    closeToNavigate()
    navigateTag(tag)
  }

  const remove = (): void => {
    hapticImpactLight(haptics)
    void commands.remove([task])
    onOpenChange(false)
  }

  const schedule = (isoDate: string | null): void => {
    hapticImpactLight(haptics)
    // `setMarkdown` reports no change, so the draft is updated by hand.
    const live = liveDraftRef.current
    const current = live !== null && live.seed === editorSeed ? live.markdown : draft
    const next = withDraftDueDate(current, isoDate)
    changeDraft(next)
    editorRef.current?.setMarkdown(next)
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent
        aria-label="Edit task"
        // On the "+"-add path the editor takes focus instead of the sheet
        // container, so typing can start immediately.
        initialFocus={
          autoFocusEditor
            ? () => {
                editorRef.current?.focus()
                return false
              }
            : undefined
        }
      >
        <DrawerTitle className="sr-only">Edit task</DrawerTitle>
        <div className="flex flex-col gap-3 p-4">
          <div className="rounded-md border border-border bg-surface px-3 py-2 focus-within:ring-1 focus-within:ring-accent">
            <NoteEditor
              key={editorSeed}
              initialContent={draft}
              singleParagraph
              onChange={changeDraft}
              markMode={markModeFromSyntax(editorMarkdownSyntax)}
              spellCheck={editorSpellCheck}
              smoothCaretAnimation={editorSmoothCaretAnimation}
              timeFormat={timeFormat}
              // A one-line editor has nothing to reorder, so keep the gutter grip off.
              blockHandle={false}
              onWikiLinkClick={openWikiLink}
              onLinkClick={onLinkClick}
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
              active={dueDate === addDaysToIsoDate(today, 1)}
              onClick={() => schedule(addDaysToIsoDate(today, 1))}
            />
            <ScheduleChip
              label="Next week"
              active={dueDate === addDaysToIsoDate(today, 7)}
              onClick={() => schedule(addDaysToIsoDate(today, 7))}
            />
            <PickDateChip
              label={dueDate !== null ? formatDayLabel(dueDate, dateFormat) : 'Pick date'}
              value={dueDate ?? today}
              onPick={schedule}
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
      className={getScheduleChipClassName(active)}
    >
      {active && icon === undefined ? <Check aria-hidden className="size-3.5" /> : icon}
      {label}
    </button>
  )
}

/**
 * A schedule chip covered by a transparent native date input, so a tap opens
 * the system date picker (`UIDatePicker` on iOS).
 */
function PickDateChip({
  label,
  value,
  onPick,
}: {
  label: string
  /** The input's ISO date: the due date, else today. */
  value: string
  onPick: (isoDate: string) => void
}): ReactElement {
  return (
    <label className={cn(getScheduleChipClassName(false), 'relative')}>
      <CalendarDays aria-hidden className="size-3.5" />
      {label}
      <input
        type="date"
        aria-label="Pick date"
        // iOS fills an empty date input with today on open and fires change.
        value={value}
        // iOS opens the picker on focus; desktop Chrome only from its icon.
        onClick={(event) => event.currentTarget.showPicker()}
        onChange={(event) => {
          const picked = event.currentTarget.value
          // Desktop Chrome's Clear button empties the value.
          if (picked !== '') {
            onPick(picked)
          }
        }}
        className="absolute inset-0 appearance-none text-base opacity-0"
      />
    </label>
  )
}

function getScheduleChipClassName(active: boolean): string {
  return cn(
    'flex h-8 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-xs font-medium',
    active ? 'border-accent/40 bg-accent-soft text-text' : 'border-border text-text-muted',
  )
}
