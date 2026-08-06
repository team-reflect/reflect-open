import {
  createContext,
  useCallback,
  use,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

/**
 * Open state for the template surfaces (docs/porting/note-templates.md):
 * the "Insert template…" picker and the "New template" name dialog — provided
 * once per workspace so the palette commands (via CommandContext) and the
 * dialogs themselves share one definition of "open", the same shape as the
 * shortcuts provider.
 */

interface NoteTemplatesContextValue {
  pickerOpen: boolean
  createOpen: boolean
  openTemplatePicker: () => void
  closeTemplatePicker: () => void
  openTemplateCreate: () => void
  closeTemplateCreate: () => void
}

const NoteTemplatesContext = createContext<NoteTemplatesContextValue | null>(null)

export function NoteTemplatesProvider({ children }: { children: ReactNode }): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const openTemplatePicker = useCallback(() => {
    setPickerOpen(true)
  }, [])
  const closeTemplatePicker = useCallback(() => {
    setPickerOpen(false)
  }, [])
  const openTemplateCreate = useCallback(() => {
    setPickerOpen(false) // the picker's empty state chains here
    setCreateOpen(true)
  }, [])
  const closeTemplateCreate = useCallback(() => {
    setCreateOpen(false)
  }, [])

  const value = useMemo<NoteTemplatesContextValue>(
    () => ({
      pickerOpen,
      createOpen,
      openTemplatePicker,
      closeTemplatePicker,
      openTemplateCreate,
      closeTemplateCreate,
    }),
    [
      pickerOpen,
      createOpen,
      openTemplatePicker,
      closeTemplatePicker,
      openTemplateCreate,
      closeTemplateCreate,
    ],
  )
  return <NoteTemplatesContext value={value}>{children}</NoteTemplatesContext>
}

export function useNoteTemplates(): NoteTemplatesContextValue {
  const context = use(NoteTemplatesContext)
  if (!context) {
    throw new Error('useNoteTemplates must be used within a NoteTemplatesProvider')
  }
  return context
}
