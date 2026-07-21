import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MutableRefObject,
  type ReactElement,
} from 'react'
import { Priority } from '@meowdown/core'
import { useKeymap } from '@meowdown/react'
import { type OpenTask } from '@reflect/core'
import { markModeFromSyntax } from '@/editor/mark-mode'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor'
import { useEditorAutocomplete } from '@/editor/use-editor-autocomplete'
import { useTagNavigation } from '@/editor/use-tag-navigation'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation'
import { taskContent } from '@/lib/tasks/task-content'
import { useTaskEditorFinalizer, type TaskEditorApi } from '@/lib/tasks/use-task-editor-finalizer'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

/**
 * The inline task editor (Plan 18, V1 parity): the sole-selected task swaps its
 * read-only text for a one-line editor seeded with the content after its marker.
 * It reuses Reflect's note editor — so it gets meowdown's built-in `[[` backlink
 * and `#` tag menus ({@link useEditorAutocomplete}) — and binds the commit/cancel/
 * complete/delete keymap. The marker (and so the checked state) is never in this
 * editor; the write-back only rewrites the content line. The single-shot rules
 * live in {@link useTaskEditorFinalizer}.
 */
/** A keyboard move between task rows: −1 up, +1 down; `span` extends the range (Shift). */
export type TaskNavigate = (direction: -1 | 1, options: { span: boolean }) => void

interface TaskEditorProps {
  task: OpenTask
  /** Persist the new content (non-empty, changed) and exit edit mode. */
  onCommit: (content: string) => void
  /**
   * Enter (V1 continuous entry): persist the current edit then add the next task.
   * `content` is the new text, `''` (emptied), or `null` (unchanged → don't rewrite).
   */
  onContinue: (content: string | null) => void
  /** Delete the task (emptied via ⌘↵, or ⌘⌫) and exit edit mode. */
  onDelete: () => void
  /** Backspace on an empty row: delete it and select the previous task (V1). */
  onDeleteEmpty: () => void
  /** Exit edit mode without writing (Escape / unchanged). */
  onCancel: () => void
  /** ⌘↵: complete the task (saving the edit first when `content` isn't null). */
  onComplete: (content: string | null) => void
  /** Checkbox click: save any change, then toggle the checked state. */
  onCheckboxToggle: (content: string | null) => void
  /** ⌘⇧K: convert the task to a plain bullet (saving the edit first when changed). */
  onConvertToBullet: (content: string | null) => void
  /** Persist a changed edit when the row unmounts (selection moved), without exiting. */
  onFlush: (content: string) => void
  /** ↑/↓ (Shift to extend): move the selection between rows while editing (V1). */
  onNavigate: TaskNavigate
  /** Lets the row checkbox toggle through the editor finalizer while editing. */
  checkboxToggleControllerRef?: MutableRefObject<(() => void) | null>
  /**
   * Lets the toolbar's "Convert to bullet" button drive the same flush-then-convert
   * the ⌘⇧K keymap does. While this row is the sole selection it holds a trigger
   * that commits the live draft and converts; it clears on unmount so the screen
   * falls back to a plain (no-edit) convert when no row is being edited.
   */
  convertControllerRef?: MutableRefObject<(() => void) | null>
}

/**
 * Binds the editor's keys inside its ProseKit context (meowdown renders children
 * there). High priority so it runs before the editor's default Enter/arrows — but
 * the `[[`/`#` menus claim Enter/Escape/arrows first while open, so those drive
 * the menu rather than navigation. This is where V1's "navigation is global"
 * lives in V2: the inline editor never traps ↑/↓ or Enter — they move between
 * rows and add the next task, even mid-edit — so the keyboard flows task to task
 * without leaving the editor. ⌘↵ completes, ⌘⌫ deletes, Backspace on an empty row
 * deletes it; all handled here, not by the screen's bulk shortcuts (which back
 * off while editing).
 */
function TaskCommitKeymap({
  apiRef,
  onNavigate,
}: {
  apiRef: MutableRefObject<TaskEditorApi>
  onNavigate: TaskNavigate
}): null {
  const keymap = useMemo(
    () => ({
      // Enter adds the next task (V1 continuous entry), never a new block.
      Enter: () => {
        apiRef.current.commitAndContinue()
        return true
      },
      'Shift-Enter': () => {
        apiRef.current.commitAndContinue()
        return true
      },
      'Mod-Enter': () => {
        apiRef.current.complete()
        return true
      },
      'Mod-Shift-k': () => {
        apiRef.current.convertToBullet()
        return true
      },
      Escape: () => {
        apiRef.current.cancel()
        return true
      },
      'Mod-Backspace': () => {
        apiRef.current.delete()
        return true
      },
      Backspace: () => {
        if (apiRef.current.isEmpty()) {
          apiRef.current.deleteEmpty()
          return true
        }
        return false
      },
      // ↑/↓ navigate between rows even mid-edit (the unmount flush saves this row);
      // Shift extends the range. Single-line tasks never need a vertical caret move.
      ArrowUp: () => {
        onNavigate(-1, { span: false })
        return true
      },
      ArrowDown: () => {
        onNavigate(1, { span: false })
        return true
      },
      'Shift-ArrowUp': () => {
        onNavigate(-1, { span: true })
        return true
      },
      'Shift-ArrowDown': () => {
        onNavigate(1, { span: true })
        return true
      },
    }),
    [apiRef, onNavigate],
  )
  useKeymap(keymap, { priority: Priority.high })
  return null
}

export function TaskEditor({
  task,
  onCommit,
  onContinue,
  onDelete,
  onDeleteEmpty,
  onCancel,
  onComplete,
  onCheckboxToggle,
  onConvertToBullet,
  onFlush,
  onNavigate,
  checkboxToggleControllerRef,
  convertControllerRef,
}: TaskEditorProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const generation = graph?.generation ?? null
  const navigate = useWikiLinkNavigation(generation)
  const onTagClick = useTagNavigation()
  const { onWikilinkSearch, onTagSearch } = useEditorAutocomplete()

  // Frozen at mount: the editor is seeded once (uncontrolled), so the commit
  // baseline must stay the seed even if `task.raw` is re-derived mid-edit.
  const [initial] = useState(() => taskContent(task.raw))
  const { apiRef, onChange } = useTaskEditorFinalizer({
    initial,
    onCommit,
    onContinue,
    onDelete,
    onDeleteEmpty,
    onCancel,
    onComplete,
    onCheckboxToggle,
    onConvertToBullet,
    onFlush,
  })

  useEffect(() => {
    if (checkboxToggleControllerRef === undefined) {
      return
    }
    checkboxToggleControllerRef.current = () => apiRef.current.checkboxToggle()
    return () => {
      checkboxToggleControllerRef.current = null
    }
  }, [checkboxToggleControllerRef, apiRef])

  // Expose the flush-then-convert trigger to the screen while this row is edited,
  // so the toolbar button converts through the same path the ⌘⇧K keymap uses —
  // never a stale-content write that drops the unsaved draft. Cleared on unmount.
  useEffect(() => {
    if (convertControllerRef === undefined) {
      return
    }
    convertControllerRef.current = () => apiRef.current.convertToBullet()
    return () => {
      convertControllerRef.current = null
    }
  }, [convertControllerRef, apiRef])

  const handleRef = useCallback((handle: NoteEditorHandle | null) => {
    handle?.focus()
  }, [])

  return (
    <div data-task-editor className="min-w-0 flex-1">
      <NoteEditor
        initialContent={initial}
        onChange={onChange}
        markMode={markModeFromSyntax(settings.editorMarkdownSyntax)}
        spellCheck={settings.editorSpellCheck}
        smoothCaretAnimation={settings.editorSmoothCaretAnimation}
        timeFormat={settings.timeFormat}
        // A one-line editor has nothing to reorder, so keep the gutter grip off.
        blockHandle={false}
        onWikiLinkClick={navigate}
        onTagClick={onTagClick}
        onWikilinkSearch={onWikilinkSearch}
        onTagSearch={onTagSearch}
        className="reflect-task-editor text-sm leading-6"
        handleRef={handleRef}
      >
        <TaskCommitKeymap apiRef={apiRef} onNavigate={onNavigate} />
      </NoteEditor>
    </div>
  )
}
