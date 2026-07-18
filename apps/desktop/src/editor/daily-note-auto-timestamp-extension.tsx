import { useState } from 'react'
import { definePlugin } from '@prosekit/core'
import { useExtension } from '@meowdown/react'
import { dailyNoteAutoTimestampPlugin } from './daily-note-auto-timestamp-plugin'

/**
 * Mounts the daily-note auto-timestamp ProseMirror plugin inside the editor's
 * ProseKit context (meowdown renders children there). The parent decides when
 * to mount this: daily notes only, and only while the user hasn't turned the
 * setting off. See {@link dailyNoteAutoTimestampPlugin} for the behavior.
 *
 * `useState`'s lazy initializer (over `useMemo`) guarantees the plugin
 * instance is constructed exactly once per component mount — React may
 * discard `useMemo` values and recompute them, which would cause
 * `useExtension` to swap plugins mid-session and reset the plugin's state.
 */
export function DailyNoteAutoTimestampExtension(): null {
  const [extension] = useState(() => definePlugin(dailyNoteAutoTimestampPlugin()))
  useExtension(extension)
  return null
}
