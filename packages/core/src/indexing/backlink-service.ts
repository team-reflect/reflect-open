import { sha256Hex } from '@reflect/utils'
import type { Backlink, BacklinkSourceCursor } from '@reflect/types'
import { requireGraphSession, type GraphSessionSource } from '../graph/graph-session.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import {
  blockContextLinesAt,
  prepareBlockContext,
  type BlockContextSource,
} from './block-context.ts'
import type { DatabaseService } from './database-service.ts'
import {
  createSourceTaskLocator,
  extractSnippetTasks,
  type SnippetTask,
  type SourceTaskLocate,
} from './snippet-tasks.ts'
import { noop } from '@ocavue/utils'

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
   * its source task ({@link extractSnippetTasks}), so a checkbox click in the
   * panel can write the toggle through to the source note.
   */
  tasks: SnippetTask[]
}

/**
 * Keyset page controls for {@link BacklinkService.getBacklinksWithContext}.
 */
export interface BacklinkContextPageOptions {
  /**
   * Maximum distinct source notes to return. A source is never split across pages.
   */
  readonly limit: number
  /**
   * The previous page's final source, or `null` for the first page.
   */
  readonly cursor: BacklinkSourceCursor | null
}

/**
 * One source-bounded page of incoming backlink contexts.
 */
export interface BacklinkContextPage {
  /**
   * Deduplicated contexts for every source included in this page.
   */
  readonly contexts: BacklinkContext[]
  /**
   * The next page's keyset cursor, or `null` when every source is loaded.
   */
  readonly nextCursor: BacklinkSourceCursor | null
  /**
   * Resolved wiki-link rows with an indexed source note, before block-context
   * deduplication. This is the only exact total available without reading
   * every source note, so it may be greater than the eventual number of
   * rendered contexts.
   */
  readonly indexedLinkCount: number
}

export interface BacklinkServiceDeps {
  readonly database: DatabaseService
  readonly noteFile: NoteFileService
  readonly graphSession: GraphSessionSource
}

/**
 * Incoming links of a note, raw or with their rendered block context.
 */
export interface BacklinkService {
  /**
   * Notes that link to `path` (resolved at query time via the `backlinks` view).
   */
  getBacklinks(path: string): Promise<Backlink[]>
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
  getBacklinksWithContext(
    path: string,
    options: BacklinkContextPageOptions,
  ): Promise<BacklinkContextPage>
}

class BacklinkServiceImpl implements BacklinkService {
  readonly #deps: BacklinkServiceDeps

  constructor(deps: BacklinkServiceDeps) {
    this.#deps = deps
  }

  async getBacklinks(path: string): Promise<Backlink[]> {
    return await this.#deps.database.read('index_backlinks', { path })
  }

  async getBacklinksWithContext(
    path: string,
    options: BacklinkContextPageOptions,
  ): Promise<BacklinkContextPage> {
    const { noteFile, graphSession, database } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      throw new RangeError('backlink page limit must be a positive safe integer')
    }

    const page = await database.read('index_backlink_page', {
      path,
      limit: options.limit,
      cursor: options.cursor,
    })
    const { sources: pageSources, nextCursor, indexedLinkCount } = page
    if (pageSources.length === 0) {
      return { contexts: [], nextCursor: null, indexedLinkCount }
    }
    // Every spelling that resolves to the target (title, aliases, daily date),
    // so sibling branches co-group under any of them — old Reflect compared
    // resolved note ids, not link text.
    const targetKeys = new Set(page.targetKeys)

    // One read *and one parse* per distinct source: a well-linked source
    // contributes many rows, and context extraction walks the parsed body.
    const sources = new Map<string, BlockContextSource | null>()
    const locators = new Map<string, SourceTaskLocate>()
    await Promise.all(
      pageSources.map(async ({ sourcePath }) => {
        try {
          const content = await noteFile.read(sourcePath, generation)
          const source = prepareBlockContext(content)
          sources.set(sourcePath, source)
          locators.set(sourcePath, createSourceTaskLocator(source, await sha256Hex(content)))
        } catch {
          sources.set(sourcePath, null)
        }
      }),
    )
    const noLocator: SourceTaskLocate = noop

    const results: BacklinkContext[] = []
    for (const pageSource of pageSources) {
      const source = sources.get(pageSource.sourcePath)
      const seenSnippets = new Set<string>()
      for (const posFrom of pageSource.positions) {
        const context =
          source == null
            ? { text: '', lineOrigins: [] }
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
          tasks: extractSnippetTasks(
            snippet,
            context.lineOrigins,
            locators.get(pageSource.sourcePath) ?? noLocator,
          ),
        })
      }
    }
    return { contexts: results, nextCursor, indexedLinkCount }
  }
}

export function createBacklinkService(deps: BacklinkServiceDeps): BacklinkService {
  return new BacklinkServiceImpl(deps)
}
