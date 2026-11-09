import { useState, type ReactElement } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import { useQuery } from '@tanstack/react-query'
import { FilePlus2, LayoutTemplate, SearchIcon } from 'lucide-react'
import { displayNoteTitle, type TemplateEntry } from '@reflect/core'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group.tsx'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry.ts'
import type { CommandContext } from '@/lib/commands/types.ts'
import { createTemplatesQueryOptions } from '@/lib/query-options.ts'
import { useGraphInfo } from '@/providers/graph-provider.tsx'
import { useNoteTemplates } from '@/providers/note-templates-provider.tsx'

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

export function TemplatePicker({ context }: TemplatePickerProps): ReactElement {
  const { pickerOpen, closeTemplatePicker, openTemplateCreate } = useNoteTemplates()
  const graph = useGraphInfo()
  const { data: templates } = useQuery({
    ...createTemplatesQueryOptions(context.services.indexQuery, graph?.root),
    enabled: graph !== null && pickerOpen,
  })

  const insert = (path: string): void => {
    closeTemplatePicker()
    const target = context.notePath()
    if (target === null) {
      return // the command opens the picker only where a note is being edited
    }
    // `TemplateService.insertTemplate` owns all feedback — a missing editor (protected or
    // still-loading note) and a failed read both surface as failed operations.
    void context.services.templates.insertTemplate(path, noteEditorHandleFor(target))
  }

  return (
    <Dialog
      open={pickerOpen}
      onOpenChange={(open) => {
        if (!open) {
          closeTemplatePicker()
        }
      }}
    >
      <DialogContent
        className="top-1/3 translate-y-0 overflow-hidden rounded-xl! p-0"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Insert template</DialogTitle>
          <DialogDescription>Choose a template to insert at the cursor</DialogDescription>
        </DialogHeader>
        <TemplateList templates={templates ?? []} onInsert={insert} onCreate={openTemplateCreate} />
      </DialogContent>
    </Dialog>
  )
}

const NEW_TEMPLATE = 'new-template'

const ITEM_CLASS_NAME =
  "relative flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-surface-hover data-highlighted:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

interface TemplateListProps {
  templates: TemplateEntry[]
  onInsert: (path: string) => void
  onCreate: () => void
}

/**
 * The searchable list. It lives inside the dialog popup, so its query resets
 * whenever the dialog closes.
 */
function TemplateList({ templates, onInsert, onCreate }: TemplateListProps): ReactElement {
  const [query, setQuery] = useState('')
  const { contains } = Autocomplete.useFilter()
  const matches = templates.filter((template) => contains(template.title, query))

  return (
    <Autocomplete.Root
      inline
      open
      // The list is filtered here, so the "New template" row survives every query.
      mode="none"
      items={[...matches, NEW_TEMPLATE]}
      value={query}
      onValueChange={setQuery}
      autoHighlight="always"
      keepHighlight
    >
      <div className="flex flex-col bg-popover p-1 text-popover-foreground">
        <div className="p-1 pb-0">
          <InputGroup className="h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
            <Autocomplete.Input
              aria-label="Insert template"
              placeholder="Insert template…"
              render={<InputGroupInput />}
            />
            <InputGroupAddon>
              <SearchIcon className="size-4 shrink-0 opacity-50" />
            </InputGroupAddon>
          </InputGroup>
        </div>
        {matches.length === 0 ? <div className="py-6 text-center text-sm">No templates</div> : null}
        <Autocomplete.List className="max-h-72 scroll-py-1 overflow-y-auto p-1 scrollbar-none">
          {(item: TemplateEntry | typeof NEW_TEMPLATE) => {
            return item === NEW_TEMPLATE ? (
              <Autocomplete.Item
                key={NEW_TEMPLATE}
                value={item}
                onClick={onCreate}
                className={ITEM_CLASS_NAME}
              >
                <FilePlus2 aria-hidden strokeWidth={1.75} className="text-text-muted" />
                New template
              </Autocomplete.Item>
            ) : (
              <Autocomplete.Item
                key={item.path}
                value={item}
                onClick={() => onInsert(item.path)}
                className={ITEM_CLASS_NAME}
              >
                <LayoutTemplate aria-hidden strokeWidth={1.75} className="text-text-muted" />
                <span className="truncate">{displayNoteTitle(item.title)}</span>
              </Autocomplete.Item>
            )
          }}
        </Autocomplete.List>
      </div>
    </Autocomplete.Root>
  )
}
