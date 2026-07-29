import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MINIMAX_REGION_ID,
  MINIMAX_REGIONS,
  minimaxBaseUrl,
  providerRegions,
} from './minimax'

describe('minimaxBaseUrl', () => {
  it('resolves each region to its OpenAI-compatible host', () => {
    expect(minimaxBaseUrl('global_en')).toBe('https://api.minimax.io/v1')
    expect(minimaxBaseUrl('cn_zh')).toBe('https://api.minimaxi.com/v1')
  })

  it('falls back to the default (global) region for absent or unknown ids', () => {
    const fallback = MINIMAX_REGIONS[0].baseUrl
    expect(minimaxBaseUrl(undefined)).toBe(fallback)
    expect(minimaxBaseUrl('mars')).toBe(fallback)
    expect(DEFAULT_MINIMAX_REGION_ID).toBe('global_en')
  })
})

describe('providerRegions', () => {
  it('offers regions only for the multi-region provider', () => {
    expect(providerRegions('minimax')).toBe(MINIMAX_REGIONS)
    expect(providerRegions('openai')).toBeNull()
    expect(providerRegions('openrouter')).toBeNull()
  })
})
