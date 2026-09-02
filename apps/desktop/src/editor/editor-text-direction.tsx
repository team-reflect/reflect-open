import { useEffect } from 'react'
import type { EditorTextDirection } from '@reflect/core'
import { useEditor } from '@meowdown/react'
import { whenEditorMounted } from '@/editor/when-editor-mounted'

interface NativeEditorTextDirectionProps {
  readonly direction: EditorTextDirection
}

/**
 * Sets one native direction policy on the Meowdown content root. The browser
 * resolves `auto` from the document's first strong character; ProseMirror
 * leaves root attributes it did not create in place across document updates.
 */
export function NativeEditorTextDirection({ direction }: NativeEditorTextDirectionProps): null {
  const editor = useEditor()

  useEffect(
    () =>
      whenEditorMounted(editor, () => {
        editor.view.dom.setAttribute('dir', direction)
      }),
    [direction, editor],
  )

  return null
}
