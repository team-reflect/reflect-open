import type { Database } from '@reflect/db'
import { sql, type Selectable } from 'kysely'
import { readNote } from '../graph/commands'
import { blockContextLinesAt, prepareBlockContext, type BlockContextSource } from './block-context'
import { db } from './db'
import { extractSnippetTasks, type SnippetTask } from './snippet-tasks'

export type Backlink = Pick<
  Selectable<Database['backlinks']>,
  'sourcePath' | 'kind' | 'targetRaw' | 'alias' | 'posFrom' | 'posTo'
>

/** Notes that link to `path` (resolved at query time via the `backlinks` view). */
export function getBacklinks(path: string): Promise<Backlink[]> {
  return db
    .selectFrom('backlinks')
    .where('targetPath', '=', path)
    .select(['sourcePath', 'kind', 'targetRaw', 'alias', 'posFrom', 'posTo'])
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
 * The last source note in a backlink page. Sources are ordered by the same
 * recency key as the panel, with path as the deterministic tiebreak.
 */
export interface BacklinkSourceCursor {
  readonly recencyMs: number
  readonly sourcePath: string
}

/** Keyset page controls for {@link getBacklinksWithContext}. */
export interface BacklinkContextPageOptions {
  /** Maximum distinct source notes to return. A source is never split across pages. */
  readonly limit: number
  /** The previous page's final source, or `null` for the first page. */
  readonly cursor: BacklinkSourceCursor | null
}

/** One source-bounded page of incoming backlink contexts. */
export interface BacklinkContextPage {
  /** Deduplicated contexts for every source included in this page. */
  readonly contexts: BacklinkContext[]
  /** The next page's keyset cursor, or `null` when every source is loaded. */
  readonly nextCursor: BacklinkSourceCursor | null
  /**
   * Resolved wiki-link rows with an indexed source note, before block-context
   * deduplication. This is the only exact total available without reading
   * every source note, so it may be greater than the eventual number of
   * rendered contexts.
   */
  readonly indexedLinkCount: number
}

const sourceRecency = sql<number>`coalesce(
  strftime('%s', "notes"."daily_date") * 1000,
  "notes"."updated_at"
)`

function afterSource(cursor: BacklinkSourceCursor) {
  return sql<boolean>`(
    ${sourceRecency} < ${cursor.recencyMs}
    or (${sourceRecency} = ${cursor.recencyMs}
      and "backlinks"."source_path" > ${cursor.sourcePath})
  )`
}

function throughSource(cursor: BacklinkSourceCursor) {
  return sql<boolean>`(
    ${sourceRecency} > ${cursor.recencyMs}
    or (${sourceRecency} = ${cursor.recencyMs}
      and "backlinks"."source_path" <= ${cursor.sourcePath})
  )`
}

/**
 * Backlinks of `path` with source titles and block-context snippets. One read
 * per distinct source; a source that vanished between query and read keeps its
 * row with an empty snippet (the index lags deletes only briefly). Mentions of
 * one source that produce an identical context collapse into one row — two
 * links to `path` in the same paragraph read as a single reference, exactly as
 * old Reflect deduplicated on `[target, contextHtml]`. Pages are bounded by
 * complete source notes rather than raw links: `limit` sources are selected by
 * recency/path keyset, then every matching position in those sources is
 * processed. Consequently `contexts.length` may be greater than `limit`.
 */
export async function getBacklinksWithContext(
  path: string,
  options: BacklinkContextPageOptions,
): Promise<BacklinkContextPage> {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
    throw new RangeError('backlink page limit must be a positive safe integer')
  }

  let sourceQuery = db
    .selectFrom('backlinks')
    .innerJoin('notes', 'notes.path', 'backlinks.sourcePath')
    .where('targetPath', '=', path)
    .select([
      'backlinks.sourcePath',
      'notes.title as sourceTitle',
      sourceRecency.as('recencyMs'),
    ])
    .$narrowType<{ sourcePath: string }>()
    .distinct()
  if (options.cursor !== null) {
    sourceQuery = sourceQuery.where(afterSource(options.cursor))
  }

  const candidateLimit =
    options.limit === Number.MAX_SAFE_INTEGER ? options.limit : options.limit + 1
  const [candidateSources, countRow] = await Promise.all([
    sourceQuery
      .orderBy(sourceRecency, 'desc')
      .orderBy('backlinks.sourcePath')
      .limit(candidateLimit)
      .execute(),
    db
      .selectFrom('backlinks')
      .innerJoin('notes', 'notes.path', 'backlinks.sourcePath')
      .where('targetPath', '=', path)
      .select(sql<number>`count(*)`.as('count'))
      .executeTakeFirst(),
  ])
  const pageSources = candidateSources.slice(0, options.limit)
  const lastSource = pageSources.at(-1)
  const nextCursor =
    candidateSources.length > options.limit && lastSource !== undefined
      ? { recencyMs: lastSource.recencyMs, sourcePath: lastSource.sourcePath }
      : null
  const indexedLinkCount = countRow?.count ?? 0

  if (lastSource === undefined) {
    return { contexts: [], nextCursor: null, indexedLinkCount }
  }

  // Select the complete source range rather than binding one parameter per
  // source path. This keeps arbitrarily large safe limits below SQLite's bound
  // parameter ceiling; the selected-path guard below also closes the tiny race
  // where an index write lands between the source and context queries.
  let contextRowQuery = db
    .selectFrom('backlinks')
    .innerJoin('notes', 'notes.path', 'backlinks.sourcePath')
    .where('targetPath', '=', path)
    .where(throughSource({
      recencyMs: lastSource.recencyMs,
      sourcePath: lastSource.sourcePath,
    }))
    .select(['backlinks.sourcePath', 'backlinks.posFrom'])
    .$narrowType<{ sourcePath: string; posFrom: number }>()
  if (options.cursor !== null) {
    contextRowQuery = contextRowQuery.where(afterSource(options.cursor))
  }
  const rows = await contextRowQuery
    .orderBy(sourceRecency, 'desc')
    .orderBy('backlinks.sourcePath')
    .orderBy('backlinks.posFrom')
    .execute()

  const selectedSourcePaths = new Set(pageSources.map((source) => source.sourcePath))
  const positionsBySource = new Map<string, number[]>()
  for (const row of rows) {
    if (!selectedSourcePaths.has(row.sourcePath)) {
      continue
    }
    const positions = positionsBySource.get(row.sourcePath)
    if (positions === undefined) {
      positionsBySource.set(row.sourcePath, [row.posFrom])
    } else {
      positions.push(row.posFrom)
    }
  }

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
    pageSources.map(async ({ sourcePath }) => {
      try {
        sources.set(sourcePath, prepareBlockContext(await readNote(sourcePath)))
      } catch {
        sources.set(sourcePath, null)
      }
    }),
  )

  const results: BacklinkContext[] = []
  for (const pageSource of pageSources) {
    const source = sources.get(pageSource.sourcePath)
    const seenSnippets = new Set<string>()
    for (const posFrom of positionsBySource.get(pageSource.sourcePath) ?? []) {
      const context =
        source == null
          ? { text: '', lineOrigins: [], lineSourceTexts: [] }
          : blockContextLinesAt(source, posFrom, targetKeys)
      const snippet = context.text
      if (snippet !== '') {
        if (seenSnippets.has(snippet)) {
          continue
        }
        seenSnippets.add(snippet)
      }
      results.push({
        sourcePath: pageSource.sourcePath,
        sourceTitle: pageSource.sourceTitle,
        snippet,
        posFrom,
        tasks: extractSnippetTasks(snippet, context.lineOrigins, context.lineSourceTexts),
      })
    }
  }
  return { contexts: results, nextCursor, indexedLinkCount }
}
