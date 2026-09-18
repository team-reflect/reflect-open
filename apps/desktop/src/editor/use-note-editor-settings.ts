import type { ComponentProps } from 'react'
import { markModeFromSyntax } from '@/editor/mark-mode'
import type { NoteEditor } from '@/editor/note-editor'
import { useSettings } from '@/providers/settings-provider'

type NoteEditorSettings = Pick<
  ComponentProps<typeof NoteEditor>,
  'markMode' | 'spellCheck' | 'smoothCaretAnimation' | 'timeFormat' | 'bulletAfterHeading'
>

/** The Settings → Editor preferences a full note editor applies, as `NoteEditor` props. */
export function useNoteEditorSettings(): NoteEditorSettings {
  const { settings } = useSettings()
  return {
    markMode: markModeFromSyntax(settings.editorMarkdownSyntax),
    spellCheck: settings.editorSpellCheck,
    smoothCaretAnimation: settings.editorSmoothCaretAnimation,
    timeFormat: settings.timeFormat,
    bulletAfterHeading: settings.editorBulletAfterHeading,
  }
}
