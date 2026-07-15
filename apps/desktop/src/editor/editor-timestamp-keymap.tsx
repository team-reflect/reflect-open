import { useMemo } from 'react'
import { Priority, type EditorExtension } from '@meowdown/core'
import { useEditor, useKeymap } from '@meowdown/react'
import type { TimeFormat } from '@reflect/core'
import { TIMESTAMP_BINDING } from '@/editor/keymap'
import { formatTimeOfDay } from '@/lib/dates'

interface EditorTimestampKeymapProps {
  timeFormat: TimeFormat
}

/** Inserts the current time at the caret when the editor receives ⌘⇧T. */
export function EditorTimestampKeymap({ timeFormat }: EditorTimestampKeymapProps): null {
  const editor = useEditor<EditorExtension>()
  const keymap = useMemo(
    () => ({
      [TIMESTAMP_BINDING]: () =>
        editor.commands.insertText({
          text: `${formatTimeOfDay(new Date(), timeFormat)} `,
        }),
    }),
    [editor, timeFormat],
  )

  useKeymap(keymap, { priority: Priority.high })
  return null
}
