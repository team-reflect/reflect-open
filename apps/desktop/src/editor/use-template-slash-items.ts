import { useCallback } from 'react'
import type { SlashMenuItem, SlashMenuSearchHandler } from '@meowdown/react'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import type { NoteEditorHandle } from './note-editor.tsx'

/**
 * The editor's `/` menu rows for note templates (docs/porting/note-templates.md):
 * every template, A→Z, alongside meowdown's built-in blocks — the same
 * host-supplies-the-items pattern as the `[[` menu. meowdown filters the rows
 * against the typed query and removes the `/query` text before `onSelect`
 * runs, so the body lands at a clean cursor. The rows come from
 * `TemplateService.slashItems`.
 *
 * `getEditor` is read at select time, not capture time: the menu belongs to
 * exactly one editor, and a late resolve after that pane unmounted must
 * insert nowhere rather than somewhere stale.
 */
export function useTemplateSlashItems(
  getEditor: () => NoteEditorHandle | null,
): SlashMenuSearchHandler {
  const { graph } = useGraph()
  const { templates } = useCoreServices()

  return useCallback(
    async (_query: string): Promise<SlashMenuItem[]> => {
      if (graph === null) {
        return []
      }
      return await templates.slashItems(getEditor)
    },
    [graph, getEditor, templates],
  )
}
