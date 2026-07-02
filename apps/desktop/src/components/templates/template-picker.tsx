import { type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listTemplates } from '@reflect/core'
import { FilePlus2, LayoutTemplate } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry'
import type { CommandContext } from '@/lib/commands/types'
import { insertTemplate } from '@/lib/note-templates'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { useNoteTemplates } from '@/providers/note-templates-provider'

/**
 * The "Insert template…" picker (docs/porting/note-templates.md): the graph's
 * templates A→Z, chosen with the palette's keyboard model, inserted verbatim
 * (frontmatter stripped) at the cursor of the note the command targeted. The
 * ever-present "New template" row is also the feature's front door when the
 * graph has no templates yet.
 */

interface TemplatePickerProps {
  /** The command capabilities (the same context the palette runs with). */
  context: CommandContext
}

export function TemplatePicker({ context }: TemplatePickerProps): ReactElement | null {
  const { pickerOpen, closeTemplatePicker, openTemplateCreate } = useNoteTemplates()
  const { graph } = useGraph()
  const { data: templates } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'templates'],
    queryFn: listTemplates,
    enabled: graph !== null && pickerOpen,
  })

  if (!pickerOpen) {
    return null
  }

  const insert = (path: string): void => {
    closeTemplatePicker()
    const target = context.notePath()
    if (target === null) {
      return // the command opens the picker only where a note is being edited
    }
    // `insertTemplate` owns all feedback — a missing editor (protected or
    // still-loading note) and a failed read both surface as failed operations.
    void insertTemplate(path, noteEditorHandleFor(target))
  }

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
      <CommandInput placeholder="Insert template…" />
      <CommandList>
        <CommandEmpty>No templates</CommandEmpty>
        {templates !== undefined && templates.length > 0 ? (
          <CommandGroup>
            {templates.map((template) => (
              <CommandItem
                key={template.path}
                // Title + path: cmdk matches on the value, and duplicate
                // titles across files must stay distinct rows.
                value={`${template.title} ${template.path}`}
                onSelect={() => insert(template.path)}
              >
                <LayoutTemplate aria-hidden strokeWidth={1.75} className="text-text-muted" />
                <span className="truncate">{template.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        <CommandGroup forceMount>
          <CommandItem forceMount value="new-template" onSelect={openTemplateCreate}>
            <FilePlus2 aria-hidden strokeWidth={1.75} className="text-text-muted" />
            New template
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
