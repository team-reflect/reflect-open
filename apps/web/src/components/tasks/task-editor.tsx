import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react'
import { Priority } from '@meowdown/core'
import { useKeymap } from '@meowdown/react'
import type { OpenTask } from '@reflect/core'
import { markModeFromSyntax } from '@/editor/mark-mode.ts'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor.tsx'
import { useEditorAutocomplete } from '@/editor/use-editor-autocomplete.ts'
import { useTagNavigation } from '@/editor/use-tag-navigation.ts'
import { useMarkdownLinkClick } from '@/editor/use-markdown-link-click.ts'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation.ts'
import { useTaskDraft } from '@/lib/tasks/use-task-draft.ts'
import {
  useEditorMarkdownSyntax,
  useEditorSmoothCaretAnimation,
  useEditorSpellCheck,
  useTimeFormat,
} from '@/providers/settings-provider.tsx'

/**
 * A keyboard move between task rows: −1 up, +1 down; `span` extends the range (Shift).
 */
export type TaskNavigate = (direction: -1 | 1, options: { span: boolean }) => void

/**
 * What the keys of the inline task editor ask the row to do. The typed text
 * is not passed: the task commands hold it.
 */
export interface TaskEditorHandlers {
  /**
   * Enter: add the next task after this one.
   */
  onContinue: () => void
  /**
   * Escape: leave the row.
   */
  onCancel: () => void
  /**
   * Mod-Enter: complete the task.
   */
  onComplete: () => void
  /**
   * Mod-Shift-K: turn the task into a plain bullet.
   */
  onConvertToBullet: () => void
  /**
   * Mod-Backspace: delete the task.
   */
  onDelete: () => void
  /**
   * Backspace in an empty editor: delete the task and select the previous one.
   */
  onDeleteEmpty: () => void
  /**
   * Arrow keys: move the selection between rows; Shift extends it.
   */
  onNavigate: TaskNavigate
}

interface TaskEditorProps extends TaskEditorHandlers {
  task: OpenTask
}

/**
 * Binds the editor's keys inside its ProseKit context (meowdown renders children
 * there). High priority so it runs before the editor's default Enter/arrows — but
 * the `[[`/`#` menus claim Enter/Escape/arrows first while open, so those drive
 * the menu rather than navigation. The inline editor never traps ↑/↓ or Enter:
 * they move between rows and add the next task, even mid-edit.
 */
function TaskEditorKeymap({
  handlersRef,
  isEmpty,
}: {
  handlersRef: RefObject<TaskEditorHandlers>
  isEmpty: () => boolean
}): null {
  const keymap = useMemo(() => createTaskKeymap(handlersRef, isEmpty), [handlersRef, isEmpty])
  useKeymap(keymap, { priority: Priority.high })
  return null
}

function createTaskKeymap(
  handlersRef: RefObject<TaskEditorHandlers>,
  isEmpty: () => boolean,
): Record<string, () => boolean> {
  const run = (handle: (handlers: TaskEditorHandlers) => void) => () => {
    handle(handlersRef.current)
    return true
  }
  return {
    Enter: run((handlers) => handlers.onContinue()),
    'Shift-Enter': run((handlers) => handlers.onContinue()),
    'Mod-Enter': run((handlers) => handlers.onComplete()),
    'Mod-Shift-k': run((handlers) => handlers.onConvertToBullet()),
    Escape: run((handlers) => handlers.onCancel()),
    'Mod-Backspace': run((handlers) => handlers.onDelete()),
    Backspace: () => {
      if (isEmpty()) {
        handlersRef.current.onDeleteEmpty()
        return true
      }
      return false
    },
    ArrowUp: run((handlers) => handlers.onNavigate(-1, { span: false })),
    ArrowDown: run((handlers) => handlers.onNavigate(1, { span: false })),
    'Shift-ArrowUp': run((handlers) => handlers.onNavigate(-1, { span: true })),
    'Shift-ArrowDown': run((handlers) => handlers.onNavigate(1, { span: true })),
  }
}

/**
 * The inline task editor (Plan 18, V1 parity): the sole-selected task swaps its
 * read-only text for a one-line editor seeded with the content after its marker.
 * It reuses Reflect's note editor, so it gets meowdown's `[[` backlink and `#`
 * tag menus. The editor is uncontrolled: it reads the task's Markdown once, and
 * each change goes to the task commands, which save the text when a command
 * names the task or the editor goes away.
 */
export function TaskEditor({ task, ...handlers }: TaskEditorProps): ReactElement {
  const timeFormat = useTimeFormat()
  const editorMarkdownSyntax = useEditorMarkdownSyntax()
  const editorSpellCheck = useEditorSpellCheck()
  const editorSmoothCaretAnimation = useEditorSmoothCaretAnimation()
  const navigate = useWikiLinkNavigation()
  const onLinkClick = useMarkdownLinkClick(null)
  const onTagClick = useTagNavigation()
  const { onWikilinkSearch, onTagSearch } = useEditorAutocomplete()

  const [initial] = useState(() => task.markdown)
  const currentRef = useRef(initial)
  const setDraft = useTaskDraft(task)
  const onChange = useCallback(
    (markdown: string) => {
      currentRef.current = markdown
      setDraft(markdown)
    },
    [setDraft],
  )
  const isEmpty = useCallback(() => currentRef.current.trim() === '', [])
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })

  const handleRef = useCallback((handle: NoteEditorHandle | null) => {
    handle?.focus()
  }, [])

  return (
    <div data-task-editor className="min-w-0 flex-1">
      <NoteEditor
        initialContent={initial}
        singleParagraph
        onChange={onChange}
        markMode={markModeFromSyntax(editorMarkdownSyntax)}
        spellCheck={editorSpellCheck}
        smoothCaretAnimation={editorSmoothCaretAnimation}
        timeFormat={timeFormat}
        // A one-line editor has nothing to reorder, so keep the gutter grip off.
        blockHandle={false}
        onWikiLinkClick={navigate}
        onLinkClick={onLinkClick}
        onTagClick={onTagClick}
        onWikilinkSearch={onWikilinkSearch}
        onTagSearch={onTagSearch}
        className="reflect-task-editor text-sm"
        handleRef={handleRef}
      >
        <TaskEditorKeymap handlersRef={handlersRef} isEmpty={isEmpty} />
      </NoteEditor>
    </div>
  )
}
