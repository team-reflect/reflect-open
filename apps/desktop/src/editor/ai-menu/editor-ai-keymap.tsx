import { useMemo } from 'react'
import { Priority } from '@meowdown/core'
import { useKeymap } from '@meowdown/react'
import { registerKeymap } from '@/editor/keymap'

/** The editor-scope binding that opens the AI menu on the current selection. */
export const AI_MENU_BINDING = 'Mod-Shift-j'

registerKeymap('editor', { [AI_MENU_BINDING]: 'Open the AI menu on the selection' })

/**
 * Binds ⌘⇧J inside the editor's ProseKit context (meowdown renders children
 * there) to open the selection AI menu. The trigger returns whether it
 * consumed the key — a private note or an empty selection lets it fall
 * through.
 */
export function EditorAiKeymap({ onTrigger }: { onTrigger: () => boolean }): null {
  const keymap = useMemo(
    () => ({
      [AI_MENU_BINDING]: () => onTrigger(),
    }),
    [onTrigger],
  )
  useKeymap(keymap, { priority: Priority.high })
  return null
}
