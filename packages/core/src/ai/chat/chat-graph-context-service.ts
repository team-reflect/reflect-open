import type { GraphStatsService } from '../../indexing/graph-stats-service.ts'
import type { CloudGraphContext, PrivacyService } from '../../privacy/privacy-service.ts'
import type { CloudSafe } from '../../privacy/cloud-safe.ts'

/**
 * The graph-level grounding block for one chat turn's system prompt: what
 * the graph is called, how many notes the assistant can see, the span of
 * the daily journal, and which tags exist — so tag filters and date ranges
 * are typed from knowledge, not guessed. Loaded fresh per turn (the stats
 * are three local SQLite reads), computed over non-private rows only.
 */

/**
 * Most tags the prompt lists (token budget — the most-used tags win).
 */
export const MAX_CONTEXT_TAGS = 40

export interface ChatGraphContextServiceDeps {
  readonly graphStats: GraphStatsService
  readonly privacy: PrivacyService
}

/**
 * Loads the graph overview that a chat turn's system prompt carries.
 */
export interface ChatGraphContextService {
  /**
   * Load the prompt context for the open graph, named `graphName`.
   */
  load(graphName: string): Promise<CloudSafe<CloudGraphContext>>
}

class ChatGraphContextServiceImpl implements ChatGraphContextService {
  readonly #deps: ChatGraphContextServiceDeps

  constructor(deps: ChatGraphContextServiceDeps) {
    this.#deps = deps
  }

  async load(graphName: string): Promise<CloudSafe<CloudGraphContext>> {
    const { graphStats, privacy } = this.#deps
    const stats = await graphStats.loadGraphStats({ tagLimit: MAX_CONTEXT_TAGS })
    return privacy.cloudSafeGraphContext({ graphName, ...stats })
  }
}

export function createChatGraphContextService(
  deps: ChatGraphContextServiceDeps,
): ChatGraphContextService {
  return new ChatGraphContextServiceImpl(deps)
}
