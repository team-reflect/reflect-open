import { useLayoutEffect, type RefObject } from 'react'
import { useEditor } from '@meowdown/react'
import type { EditorExtension } from '@meowdown/core'

/**
 * Publishes a reader for the position at the end of the note's title: the
 * end of the first block when it is a non-empty level-1 heading, else `null`.
 * Mounted inside the editor's ProseKit context.
 */
export function TitleEndBridge({
  titleEndRef,
}: {
  titleEndRef: RefObject<(() => number | null) | null>
}): null {
  const editor = useEditor<EditorExtension>()

  useLayoutEffect(() => {
    titleEndRef.current = () => {
      if (!editor.mounted) {
        return null
      }
      const title = editor.state.doc.firstChild
      if (title?.type.name !== 'heading' || title.attrs.level !== 1 || title.content.size === 0) {
        return null
      }
      return 1 + title.content.size
    }
    return () => {
      titleEndRef.current = null
    }
  }, [editor, titleEndRef])

  return null
}
