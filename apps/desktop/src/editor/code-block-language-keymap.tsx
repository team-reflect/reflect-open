import { useMemo } from 'react'
import { Priority } from '@meowdown/core'
import { useEditor, useKeymap } from '@meowdown/react'
import { CODE_BLOCK_LANGUAGE_BINDING } from '@/editor/keymap.ts'
import { openCodeBlockLanguagePicker } from './code-block-language-picker.ts'

/**
 * Binds ⌘P inside the editor's ProseKit context to the language picker of the code block under
 * the caret, like Raycast's ⌘P for secondary actions. Outside a code block the key falls through.
 */
export function CodeBlockLanguageKeymap(): null {
  const editor = useEditor()
  const keymap = useMemo(
    () => ({
      [CODE_BLOCK_LANGUAGE_BINDING]: () => openCodeBlockLanguagePicker(editor.view),
    }),
    [editor],
  )
  useKeymap(keymap, { priority: Priority.high })
  return null
}
