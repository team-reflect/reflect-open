import { useSettingsField } from '@/providers/settings-provider.tsx'
import { formatNoteLabel, type LabeledNote } from '@/lib/note-label.ts'

/** {@link formatNoteLabel} bound to the user's date-format setting. */
export function useNoteLabel(): (note: LabeledNote) => string {
  const dateFormat = useSettingsField('dateFormat')
  return (note) => formatNoteLabel(note, dateFormat)
}
