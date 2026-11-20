import type { CoreServices } from '@reflect/core'

/**
 * Persist the semantic-search opt-in. Downloading the local model (~90MB) is
 * the user's call, never automatic: EmbeddingsSync loads the model when the
 * flag flips on and backfills once it is `ready`; later launches load from
 * cache. A `failed` runtime retries only on an explicit action like this one.
 */
export function enableSemanticSearch({ settings, semanticSearch }: CoreServices): void {
  settings.update({ semanticSearchEnabled: true })
  void semanticSearch.retryFailedModel()
}
