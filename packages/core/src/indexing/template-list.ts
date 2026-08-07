import { db } from './db'

/**
 * The graph's note templates (`templates/*.md`), as the insert picker and the
 * settings section list them. Templates are indexed like notes (same watcher,
 * same projection) but carry `kind = 'template'`, which every note surface
 * excludes — this listing is the one query that *selects* them.
 */

/** One template: its file and its display name (H1 or filename-derived title). */
export interface TemplateEntry {
  path: string
  title: string
  /** File modification time (epoch ms). */
  mtime: number
}

/** Every template in the graph, A→Z by folded title (matching v1's menu order). */
export async function listTemplates(): Promise<TemplateEntry[]> {
  return await db
    .selectFrom('notes')
    .where('kind', '=', 'template')
    .select(['path', 'title', 'mtime'])
    .orderBy('titleKey')
    .orderBy('path')
    .execute()
}
