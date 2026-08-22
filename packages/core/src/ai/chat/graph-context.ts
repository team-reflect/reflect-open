import { loadGraphStats, type GraphStats, type GraphStatsOptions } from '../../indexing/graph-stats'
import {
  cloudSafeGraphContext,
  type CloudGraphContext,
  type CloudSafe,
} from '../../privacy/checkers'

/**
 * The graph-level grounding block for one chat turn's system prompt: what
 * the graph is called, how many notes the assistant can see, the span of
 * the daily journal, and which tags exist — so tag filters and date ranges
 * are typed from knowledge, not guessed. Loaded fresh per turn (the stats
 * are three local SQLite reads), computed over non-private rows only.
 */

/** Most tags the prompt lists (token budget — the most-used tags win). */
export const MAX_CONTEXT_TAGS = 40

/** Injectable effects so tests can drive the loader without a live bridge. */
export interface GraphContextDeps {
  loadGraphStatsFn?: (options: GraphStatsOptions) => Promise<GraphStats>
}

/** Load the prompt context for the open graph. `deps` is a test seam. */
export async function loadChatGraphContext(
  graphName: string,
  deps: GraphContextDeps = {},
): Promise<CloudSafe<CloudGraphContext>> {
  const loadStatsFn = deps.loadGraphStatsFn ?? loadGraphStats
  const stats = await loadStatsFn({ tagLimit: MAX_CONTEXT_TAGS })
  return cloudSafeGraphContext({ graphName, ...stats })
}
