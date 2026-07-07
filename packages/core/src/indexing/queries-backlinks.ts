import type { Database } from '@reflect/db'
import { sql, type Selectable } from 'kysely'
import { readNote } from '../graph/commands'
import { blockContextLinesAt, prepareBlockContext, type BlockContextSource } from './block-context'
import { db } from './db'
import { extractSnippetTasks, type SnippetTask } from './snippet-tasks'

export type Backlink = Pick<
  Selectable<Database['backlinks']>,
  'sourcePath' | 'targetRaw' | 'alias' | 'posFrom' | 'posTo'
>

/** Notes that link to `path` (resolved at query time via the `backlinks` view). */
export function getBacklinks(path: string): Promise<Backlink[]> {
  return db
    .selectFrom('backlinks')
    .where('targetPath', '=', path)
    .select(['sourcePath', 'targetRaw', 'alias', 'posFrom', 'posTo'])
    .orderBy('sourcePath')
    .execute()
}

/** One backlink with the context the panel renders (Plan 07). */
export interface BacklinkContext {
  sourcePath: string
  sourceTitle: string
  /**
   * The Markdown block context around the link (old Reflect's rules — see
   * {@link blockContextAt}): the whole paragraph, the containing list item with
   * its children, or the heading's section. Empty when the file is unreadable.
   * Never windowed: a half-cut Markdown token would garble the rendered snippet.
   */
  snippet: string
  posFrom: number
  /**
   * The snippet's rendered task checkboxes in document order, each anchored to
   * its source-note marker ({@link extractSnippetTasks}), so a checkbox click
   * in the panel can write the toggle through to the source note.
   */
  tasks: SnippetTask[]
}

/**
 * Backlinks of `path` with source titles and block-context snippets. One read
 * per distinct source; a source that vanished between query and read keeps its
 * row with an empty snippet (the index lags deletes only briefly). Mentions of
 * one source that produce an identical context collapse into one row — two
 * links to `path` in the same paragraph read as a single reference, exactly as
 * old Reflect deduplicated on `[target, contextHtml]`.
 */
export async function getBacklinksWithContext(path: string): Promise<BacklinkContext[]> {
  const rows = await db
    .selectFrom('backlinks')
    .innerJoin('notes', 'notes.path', 'backlinks.sourcePath')
    .where('targetPath', '=', path)
    .select(['backlinks.sourcePath', 'backlinks.posFrom', 'notes.title as sourceTitle'])
    .$narrowType<{ sourcePath: string; posFrom: number }>()
    .orderBy(
      sql`coalesce(strftime('%s', "notes"."daily_date") * 1000, "notes"."updated_at")`,
      'desc',
    )
    .orderBy('backlinks.sourcePath')
    .orderBy('backlinks.posFrom')
    .execute()

  // Every spelling that resolves to the target (title, aliases, daily date),
  // so sibling branches co-group under any of them — old Reflect compared
  // resolved note ids, not link text.
  const targetKeys = new Set(
    (await db.selectFrom('noteKeys').where('notePath', '=', path).select('key').execute())
      .map((row) => row.key)
      .filter((key): key is string => typeof key === 'string'),
  )

  // One read *and one parse* per distinct source: a well-linked source
  // contributes many rows, and context extraction walks the parsed body.
  const sources = new Map<string, BlockContextSource | null>()
  await Promise.all(
    [...new Set(rows.map((row) => row.sourcePath))].map(async (sourcePath) => {
      try {
        sources.set(sourcePath, prepareBlockContext(await readNote(sourcePath)))
      } catch {
        sources.set(sourcePath, null)
      }
    }),
  )

  const seen = new Set<string>()
  const results: BacklinkContext[] = []
  for (const row of rows) {
    const source = sources.get(row.sourcePath)
    const context =
      source == null
        ? { text: '', lineOrigins: [], lineSourceTexts: [] }
        : blockContextLinesAt(source, row.posFrom, targetKeys)
    const snippet = context.text
    if (snippet !== '') {
      const key = `${row.sourcePath}\u0000${snippet}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
    }
    results.push({
      sourcePath: row.sourcePath,
      sourceTitle: row.sourceTitle,
      snippet,
      posFrom: row.posFrom,
      tasks: extractSnippetTasks(snippet, context.lineOrigins, context.lineSourceTexts),
    })
  }
  return results
}
