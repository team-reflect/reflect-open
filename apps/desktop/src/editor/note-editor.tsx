import { useCallback } from 'react'
import { Editor, type ChangeHandlerOptions, type MarkMode } from '@meowdown/react'
import '@meowdown/core/style.css'

interface NoteEditorProps {
  /** Initial markdown. meowdown reads this only on first render (uncontrolled). */
  initialContent: string
  /** Called with the current markdown whenever the document changes. */
  onChange?: (markdown: string) => void
  /** How markdown syntax characters are shown; `focus` reveals them near the caret. */
  markMode?: MarkMode
}

/**
 * Thin wrapper over meowdown's `<Editor>` (Plan 05). Kept deliberately small so
 * later phases can swap in a custom-extension editor (wiki-links, images,
 * checkboxes) without touching call sites.
 *
 * Note: `<Editor>` is uncontrolled — changing `initialContent` after mount is
 * ignored. To show a different note, remount with a `key` or drive the editor
 * imperatively (see Plan 05).
 */
export function NoteEditor({ initialContent, onChange, markMode = 'focus' }: NoteEditorProps) {
  const handleChange = useCallback(
    ({ getMarkdown }: ChangeHandlerOptions) => {
      onChange?.(getMarkdown())
    },
    [onChange],
  )

  return <Editor markMode={markMode} initialContent={initialContent} onChange={handleChange} />
}
