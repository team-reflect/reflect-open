import { useCallback } from 'react'
import type { SlashMenuItem, SlashMenuSearchHandler } from '@meowdown/react'
import { openZoteroPicker } from '@/components/zotero/zotero-picker-store'

/**
 * The `/` menu's Zotero row: opens the Zotero item picker targeting this
 * pane's own note. Same host-supplies-the-items pattern as the template rows
 * (`useTemplateSlashItems`); meowdown filters against the typed query and
 * removes the `/query` text before `onSelect` runs.
 */
export function useZoteroSlashItem(notePath: string): SlashMenuSearchHandler {
  return useCallback(
    async (_query: string): Promise<SlashMenuItem[]> => [
      {
        id: 'zotero-item',
        label: 'Zotero item',
        keywords: ['zotero', 'citation', 'reference', 'paper', 'literature'],
        onSelect: () => openZoteroPicker(notePath),
      },
    ],
    [notePath],
  )
}
