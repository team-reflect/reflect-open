import { useCallback } from 'react'
import type { SlashMenuItem, SlashMenuSearchHandler } from '@meowdown/react'
import { hasBridge, listTemplates } from '@reflect/core'
import { insertTemplate } from '@/lib/note-templates'
import { useGraph } from '@/providers/graph-provider'
import type { NoteEditorHandle } from './note-editor'

/**
 * The editor's `/` menu rows for note templates (docs/porting/note-templates.md):
 * every template, A→Z, alongside meowdown's built-in blocks — the same
 * host-supplies-the-items pattern as the `[[` menu. meowdown filters the rows
 * against the typed query and removes the `/query` text before `onSelect`
 * runs, so the body lands at a clean cursor.
 *
 * `getEditor` is read at select time, not capture time: the menu belongs to
 * exactly one editor, and a late resolve after that pane unmounted must
 * insert nowhere rather than somewhere stale.
 */
export function useTemplateSlashItems(
  getEditor: () => NoteEditorHandle | null,
): SlashMenuSearchHandler {
  const { graph } = useGraph()

  return useCallback(
    async (_query: string): Promise<SlashMenuItem[]> => {
      if (!hasBridge() || graph === null) {
        return []
      }
      const templates = await listTemplates()
      return templates.map((template) => ({
        id: template.path,
        label: template.title,
        // v1 parity: typing `/template` lists every template, whatever its name.
        keywords: ['template'],
        onSelect: () => {
          void insertTemplate(template.path, getEditor())
        },
      }))
    },
    [graph, getEditor],
  )
}
