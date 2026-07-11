import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { errorMessage, listTemplates, type TemplateEntry } from '@reflect/core'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation'
import { deleteOpenNote } from '@/lib/note-delete'
import { renameTemplate } from '@/lib/note-templates'
import { startOperation } from '@/lib/operations'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { useNoteTemplates } from '@/providers/note-templates-provider'
import { SettingsField } from './field'
import { SettingsSection } from './section'

/**
 * Note templates (docs/porting/note-templates.md): the `templates/` folder as
 * a settings card. Templates are plain markdown files — a row opens one in the
 * normal editor; rename moves the file to the new name's slug; delete sends it
 * to the trash. "New template" shares the palette command's dialog.
 */
export function TemplatesSection(): ReactElement {
  const { graph } = useGraph()
  const navigateNoteLink = useNoteLinkNavigation()
  const { openTemplateCreate } = useNoteTemplates()
  const [renaming, setRenaming] = useState<TemplateEntry | null>(null)
  const [deleting, setDeleting] = useState<TemplateEntry | null>(null)
  const { data: templates } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'templates'],
    queryFn: listTemplates,
    enabled: graph !== null,
  })

  return (
    <SettingsSection id="templates">
      <SettingsField
        legend="Note templates"
        description="Markdown files in your graph's templates/ folder, inserted from the ⌘K palette."
      >
        {templates !== undefined && templates.length > 0 ? (
          <ul className="mt-3 divide-y divide-border rounded-md border border-border">
            {templates.map((template) => (
              <li key={template.path} className="group flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={(event) =>
                    navigateNoteLink({ kind: 'note', path: template.path }, event)
                  }
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm text-text hover:text-accent">
                    {template.title}
                  </span>
                  <span className="block truncate text-xs text-text-muted">{template.path}</span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Rename ${template.title}`}
                  onClick={() => setRenaming(template)}
                >
                  <Pencil aria-hidden strokeWidth={1.75} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${template.title}`}
                  onClick={() => setDeleting(template)}
                >
                  <Trash2 aria-hidden strokeWidth={1.75} />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={openTemplateCreate}>
            <Plus aria-hidden strokeWidth={1.75} />
            New template
          </Button>
        </div>
      </SettingsField>
      {renaming !== null ? (
        <TemplateRenameDialog template={renaming} onClose={() => setRenaming(null)} />
      ) : null}
      {deleting !== null ? (
        <TemplateDeleteDialog template={deleting} onClose={() => setDeleting(null)} />
      ) : null}
    </SettingsSection>
  )
}

interface TemplateDialogProps {
  template: TemplateEntry
  onClose: () => void
}

/** Rename = move onto the new name's slug and rewrite the authored title. */
function TemplateRenameDialog({ template, onClose }: TemplateDialogProps): ReactElement {
  const { graph } = useGraph()
  const [name, setName] = useState(template.title)
  const [error, setError] = useState<string | null>(null)

  const rename = async (): Promise<void> => {
    const generation = graph?.generation
    const trimmed = name.trim()
    if (generation === undefined || trimmed === '') {
      return
    }
    setError(null)
    try {
      await renameTemplate(template.path, trimmed, generation)
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose()
        }
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogTitle>Rename template</DialogTitle>
        <DialogDescription className="sr-only">
          Renames the template — its title and its file's slug.
        </DialogDescription>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void rename()
          }}
        >
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Template name"
            autoComplete="off"
            spellCheck={false}
          />
          {error !== null ? (
            <span role="alert" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </span>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={name.trim() === ''}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Delete = move the file to the trash (recoverable), confirmed first. */
function TemplateDeleteDialog({ template, onClose }: TemplateDialogProps): ReactElement {
  const { graph } = useGraph()
  const [error, setError] = useState<string | null>(null)

  const trash = async (): Promise<void> => {
    const generation = graph?.generation
    if (generation === undefined) {
      return
    }
    const operation = startOperation('Trashing template')
    setError(null)
    try {
      await deleteOpenNote(template.path, generation)
      operation.done()
      onClose()
    } catch (cause) {
      operation.fail(errorMessage(cause))
      setError(errorMessage(cause))
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose()
        }
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogTitle>Delete template?</DialogTitle>
        <DialogDescription>
          “{template.title}” moves to the trash and can be recovered from there.
        </DialogDescription>
        {error !== null ? (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </span>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => {
              void trash()
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
