import { useCallback, useMemo, type MutableRefObject, type ReactElement } from 'react'
import { Priority } from '@prosekit/core'
import { useKeymap } from '@prosekit/react'
import { type OpenTask } from '@reflect/core'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor'
import { useEditorAutocomplete } from '@/editor/use-editor-autocomplete'
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
interface TaskEditorProps {
  task: OpenTask
  /** Persist the new content (non-empty, changed) and exit edit mode. */
  onCommit: (content: string) => void
  /** Delete the task (emptied, ⌫-empty, or ⌘⌫) and exit edit mode. */
  onDelete: () => void
  /** Exit edit mode without writing (Escape / unchanged). */
  onCancel: () => void
  /** ⌘↵: complete the task (saving the edit first when `content` isn't null). */
  onComplete: (content: string | null) => void
  /** Persist a changed edit when the row unmounts (selection moved), without exiting. */
  onFlush: (content: string) => void
}

/**
 * Binds the editor's keys inside its ProseKit context (meowdown renders children
 * there). High priority so it runs before the editor's default Enter — but the
 * `[[`/`#` menus claim Enter/Escape first while open, so those select a menu item
 * rather than committing. ⌘↵ completes and ⌘⌫ deletes the task (V1) — handled
 * here, not by the screen's bulk shortcuts, which back off while editing.
 */
function TaskCommitKeymap({ apiRef }: { apiRef: MutableRefObject<TaskEditorApi> }): null {
  const keymap = useMemo(
    () => ({
      // A task is one line, never a new block.
      Enter: () => {
        apiRef.current.commit()
        return true
      },
      'Shift-Enter': () => {
        apiRef.current.commit()
        return true
      },
      'Mod-Enter': () => {
        apiRef.current.complete()
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
    }),
    [apiRef],
  )
  useKeymap(keymap, { priority: Priority.high })
  return null
}

export function TaskEditor({
  task,
  onCommit,
  onDelete,
  onCancel,
  onComplete,
  onFlush,
}: TaskEditorProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const generation = graph?.generation ?? null
  const navigate = useWikiLinkNavigation(generation)
  const { onWikilinkSearch, onTagSearch } = useEditorAutocomplete()

  const initial = useMemo(() => taskContent(task.raw), [task.raw])
  const { apiRef, onChange } = useTaskEditorFinalizer({
    initial,
    onCommit,
    onDelete,
    onCancel,
    onComplete,
    onFlush,
  })

  const handleRef = useCallback((handle: NoteEditorHandle | null) => {
    handle?.focus()
  }, [])

  return (
    <div data-task-editor className="min-w-0 flex-1">
      <NoteEditor
        initialContent={initial}
        onChange={onChange}
        markMode={settings.editorMarkdownSyntax}
        spellCheck={settings.editorSpellCheck}
        onWikiLinkClick={navigate}
        onWikilinkSearch={onWikilinkSearch}
        onTagSearch={onTagSearch}
        className="reflect-task-editor text-sm leading-6"
        handleRef={handleRef}
      >
        <TaskCommitKeymap apiRef={apiRef} />
      </NoteEditor>
    </div>
  )
}
