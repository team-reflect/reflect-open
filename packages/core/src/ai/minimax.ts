import type { AiProviderId } from '../settings/schema'

/**
 * MiniMax exposes the same OpenAI-compatible API from two regional
 * deployments that differ only in host — and in the account each host issues
 * keys for, so a key minted for one region is rejected by the other. A
 * configured entry therefore records which region it was created against
 * (`AiProviderConfig.region`), and every call — model dispatch and key
 * validation alike — targets that region's host.
 */

/** One selectable MiniMax deployment. */
export interface MinimaxRegion {
  /** Stable id persisted on the provider entry (`AiProviderConfig.region`). */
  id: string
  /** Human-readable name shown in the region picker. */
  label: string
  /** The OpenAI-compatible API root for this region. */
  baseUrl: string
}

/** The selectable MiniMax regions, global first (the picker default). */
export const MINIMAX_REGIONS: [MinimaxRegion, ...MinimaxRegion[]] = [
  { id: 'global_en', label: 'Global', baseUrl: 'https://api.minimax.io/v1' },
  { id: 'cn_zh', label: 'China (mainland)', baseUrl: 'https://api.minimaxi.com/v1' },
]

/** The region a MiniMax entry falls back to when none was chosen or stored. */
export const DEFAULT_MINIMAX_REGION_ID = MINIMAX_REGIONS[0].id

/**
 * The OpenAI-compatible base URL for `region`, falling back to the default
 * (global) region for an absent or unknown id — the same tolerance the
 * catalog shows for values a newer app version may have written.
 */
export function minimaxBaseUrl(region: string | undefined): string {
  const match = MINIMAX_REGIONS.find((candidate) => candidate.id === region)
  return (match ?? MINIMAX_REGIONS[0]).baseUrl
}

/**
 * The selectable regions for `provider`, or `null` for the single-endpoint
 * providers. Lets the add-provider shells render a region picker without
 * hard-coding which provider is regional.
 */
export function providerRegions(
  provider: AiProviderId,
): [MinimaxRegion, ...MinimaxRegion[]] | null {
  return provider === 'minimax' ? MINIMAX_REGIONS : null
}
