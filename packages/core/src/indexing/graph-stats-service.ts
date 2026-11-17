import type { MaybePromise } from '@reflect/utils'
import type { DatabaseService } from './database-service.ts'
import type { NoteTagFacet } from './note-list-service.ts'

/**
 * Graph-level aggregates for the AI chat's system prompt (the "graph
 * overview" block): how many notes the assistant can see, the span of the
 * daily journal, and which tags exist — so the model types tag filters and
 * date ranges from knowledge instead of guessing.
 *
 * Every figure is computed over `is_private = 0` rows only. These are
 * provider-bound aggregates; the privacy contract is documented on
 * `cloudSafeGraphContext` in `../privacy/privacy-service`, which is the only way this
 * data reaches a prompt.
 */

/**
 * The aggregates of one graph, private notes excluded throughout.
 */
export interface GraphStats {
  /**
   * Non-daily notes the assistant can list or read.
   */
  noteCount: number
  /**
   * Days with a (non-private) daily note.
   */
  dailyNoteCount: number
  /**
   * ISO date of the first daily note, `null` when there are none.
   */
  earliestDailyDate: string | null
  /**
   * ISO date of the latest daily note, `null` when there are none.
   */
  latestDailyDate: string | null
  /**
   * Tag facets over non-daily notes, most-used first then alphabetical.
   */
  tags: NoteTagFacet[]
  /**
   * The facet list was capped at `tagLimit` — more tags exist.
   */
  tagsTruncated: boolean
}

export interface GraphStatsOptions {
  /**
   * Facet cap — the most-used tags win (prompt token budget, not recall).
   */
  tagLimit: number
}

export interface GraphStatsServiceDeps {
  readonly database: DatabaseService
}

/**
 * Graph-level aggregates over the non-private notes.
 */
export interface GraphStatsService {
  /**
   * Load {@link GraphStats} from the active graph's index.
   */
  loadGraphStats(options: GraphStatsOptions): MaybePromise<GraphStats>
}

class GraphStatsServiceImpl implements GraphStatsService {
  readonly #deps: GraphStatsServiceDeps

  constructor(deps: GraphStatsServiceDeps) {
    this.#deps = deps
  }

  async loadGraphStats({ tagLimit }: GraphStatsOptions): Promise<GraphStats> {
    return await this.#deps.database.read('index_graph_stats', { tagLimit })
  }
}

export function createGraphStatsService(deps: GraphStatsServiceDeps): GraphStatsService {
  return new GraphStatsServiceImpl(deps)
}
