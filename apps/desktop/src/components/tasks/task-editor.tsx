import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactElement,
  type RefObject,
} from 'react'
import { Priority, getIsComposing, type EditorExtension } from '@meowdown/core'
import { useEditor, useKeymap } from '@meowdown/react'
import type { Task, TaskStore } from '@reflect/core'
import { markModeFromSyntax } from '@/editor/mark-mode.ts'
import { NoteEditor } from '@/editor/note-editor.tsx'
import { useEditorAutocomplete } from '@/editor/use-editor-autocomplete.ts'
import { useTagNavigation } from '@/editor/use-tag-navigation.ts'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation.ts'
import { useTaskStore } from '@/lib/tasks/task-store.ts'
import type { TaskCommands } from '@/lib/tasks/use-task-commands.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'

interface TaskEditorProps {
  task: Task
  commands: TaskCommands
}

/**
 * The inline editor of the sole-selected task row: the task's first paragraph
 * without its checkbox marker. Keystrokes only update the editor and the task
 * store's draft. The draft is saved when the edit ends: on Enter, on any
 * action taken on the task, when the row leaves edit mode, or on an
 * application flush.
 */
export function TaskEditor({ task, commands }: TaskEditorProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const navigate = useWikiLinkNavigation(graph?.generation ?? null)
  const onTagClick = useTagNavigation()
  const { onWikilinkSearch, onTagSearch } = useEditorAutocomplete()
  const store = useTaskStore()

  const latest = useRef({ task, store })
  useLayoutEffect(() => {
    latest.current = { task, store }
  })
  // The draft is saved when the row leaves edit mode; an application flush
  // saves it through the store itself.
  useEffect(
    () => () => {
      latest.current.store?.commitDraft(latest.current.task)
    },
    [],
  )

  return (
    <div data-task-editor className="min-w-0 flex-1">
      <NoteEditor
        initialContent={task.text}
        singleParagraph
        onChange={(markdown) => store?.draft(task, markdown)}
        markMode={markModeFromSyntax(settings.editorMarkdownSyntax)}
        spellCheck={settings.editorSpellCheck}
        smoothCaretAnimation={settings.editorSmoothCaretAnimation}
        timeFormat={settings.timeFormat}
        blockHandle={false}
        onWikiLinkClick={navigate}
        onTagClick={onTagClick}
        onWikilinkSearch={onWikilinkSearch}
        onTagSearch={onTagSearch}
        className="reflect-task-editor text-sm"
      >
        <TaskKeymap task={task} store={store} commands={commands} />
      </NoteEditor>
    </div>
  )
}

type TaskEditorInstance = ReturnType<typeof useEditor<EditorExtension>>
type KeymapDeps = TaskEditorProps & { store: TaskStore | null }

/**
 * The editor's key bindings. Built outside the component so the React
 * Compiler does not read `editor.view` (which throws before mount) while
 * checking memoized dependencies during render.
 */
function createTaskKeymap(editor: TaskEditorInstance, latest: RefObject<KeymapDeps>) {
  const atEdge = (direction: 'up' | 'down') =>
    editor.mounted && editor.view.endOfTextblock(direction)
  const move = (direction: -1 | 1, span: boolean) => () => {
    if (!atEdge(direction < 0 ? 'up' : 'down')) return false
    latest.current.commands.navigate(direction, span)
    return true
  }
  return {
    Enter: () => {
      if (getIsComposing()) return false
      latest.current.commands.continue(latest.current.task)
      return true
    },
    'Mod-Enter': () => {
      latest.current.commands.complete()
      latest.current.commands.cancel()
      return true
    },
    'Mod-Shift-k': () => {
      latest.current.commands.convert()
      return true
    },
    Escape: () => {
      const { store, task, commands } = latest.current
      store?.discardDraft(task)
      commands.cancel()
      return true
    },
    'Mod-Backspace': () => {
      latest.current.commands.remove()
      return true
    },
    Backspace: () => {
      if (editor.state.doc.textContent.trim() !== '') return false
      latest.current.commands.removeEmpty()
      return true
    },
    ArrowUp: move(-1, false),
    ArrowDown: move(1, false),
    'Shift-ArrowUp': move(-1, true),
    'Shift-ArrowDown': move(1, true),
  }
}

/**
 * The editor's keys, bound inside its ProseKit context. The autocomplete menus
 * take their keys first while open. Enter never inserts a block: a task is one
 * paragraph, and Shift+Enter inserts a soft break.
 */
function TaskKeymap(props: KeymapDeps): null {
  const editor = useEditor<EditorExtension>()
  useEffect(() => {
    editor.focus()
  }, [editor])
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })
  const keymap = useMemo(() => createTaskKeymap(editor, latest), [editor])
  useKeymap(keymap, { priority: Priority.high })
  return null
}
