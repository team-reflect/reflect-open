import type { ReactElement } from 'react'
import { createDeferredFeature } from '@/components/deferred-feature'
import { CommandDialog } from '@/components/ui/command'
import type { CommandContext } from '@/lib/commands/types'
import { useNoteTemplates } from '@/providers/note-templates-provider'

const TemplatePickerContent = createDeferredFeature(
  async () => ({ default: (await import('./template-picker-content')).TemplatePickerContent }),
  { name: 'templates' },
)

interface TemplatePickerProps {
  /** The command capabilities (the same context the palette runs with). */
  context: CommandContext
}

/** The keyboard-accessible picker for inserting a template at the cursor. */
export function TemplatePicker({ context }: TemplatePickerProps): ReactElement {
  const { pickerOpen, closeTemplatePicker } = useNoteTemplates()

  return (
    <CommandDialog
      open={pickerOpen}
      onOpenChange={(open) => {
        if (!open) {
          closeTemplatePicker()
        }
      }}
      title="Insert template"
      description="Choose a template to insert at the cursor"
    >
      <TemplatePickerContent context={context} />
    </CommandDialog>
  )
}
