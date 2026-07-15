import { describe, expect, it, vi } from 'vitest'
import type {
  AiProvidersState,
  ReconcileAssetDescriptionsInput,
  ReconcileAssetDescriptionsOutcome,
} from '@reflect/core'

const reconcileAssetDescriptions = vi.hoisted(() =>
  vi.fn<(input: ReconcileAssetDescriptionsInput) => Promise<ReconcileAssetDescriptionsOutcome>>(),
)

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  reconcileAssetDescriptions,
  reindexNotesReferencing: vi.fn(async () => {}),
}))
vi.mock('@/lib/provider-fetch', () => ({ providerFetch: vi.fn() }))
vi.mock('@/lib/operations', () => ({
  startOperation: () => ({
    progress: vi.fn(),
    done: vi.fn(),
    warn: vi.fn(),
    fail: vi.fn(),
  }),
}))
vi.mock('@/lib/query-client', () => ({ invalidateIndexQueries: vi.fn() }))

const { backfillAssetDescriptionsVisibly } = await import('./asset-backfill')

const PROVIDERS: AiProvidersState = { providers: [], defaultProviderId: null }
const OUTCOME: ReconcileAssetDescriptionsOutcome = {
  pending: 0,
  described: 0,
  skippedUpToDate: 0,
  skippedUnreferenced: 0,
  skippedPrivate: 0,
  skippedUserAuthored: 0,
  skippedOversize: 0,
  refused: 0,
  describedAssetPaths: [],
  stopped: null,
}

describe('backfillAssetDescriptionsVisibly', () => {
  it('keeps a coalesced generation live until every joined caller is stale', async () => {
    let resolveRun: (outcome: ReconcileAssetDescriptionsOutcome) => void = () => {}
    reconcileAssetDescriptions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve
        }),
    )
    let firstStale = false
    let secondStale = false

    const first = backfillAssetDescriptionsVisibly(7, PROVIDERS, () => firstStale)
    const second = backfillAssetDescriptionsVisibly(7, PROVIDERS, () => secondStale)

    expect(second).toBe(first)
    const runIsStale = reconcileAssetDescriptions.mock.calls[0]?.[0].isStale
    if (runIsStale === undefined) {
      throw new Error('expected the backfill to receive a staleness predicate')
    }
    expect(runIsStale()).toBe(false)
    firstStale = true
    expect(runIsStale()).toBe(false)
    secondStale = true
    expect(runIsStale()).toBe(true)

    resolveRun(OUTCOME)
    await expect(first).resolves.toBe(OUTCOME)
  })
})
